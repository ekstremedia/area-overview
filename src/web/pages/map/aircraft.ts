/**
 * The aircraft (ADS-B) live layer: polls `GET /api/aircraft?bbox=` for
 * the map's current viewport, renders each aircraft as a magenta
 * heading-rotated triangle via `canvasGlyphLayer.ts`, and reports its
 * on-screen count/attribution through `callbacks`. Mounted only through
 * `layers.ts`'s `mountLiveLayers` -- `MapPage.ts` never imports this file
 * directly.
 *
 * Never polls faster than `AIRCRAFT_LAYER.minPollSeconds` (5s), regardless
 * of a configured `settings.aircraft.pollSeconds` -- a hard floor to keep
 * this kiosk's own request rate well within the ADS-B providers'
 * ~1req/s fair-use guidance, on top of whatever margin other clients of
 * the same provider are also using.
 */
import type * as Leaflet from 'leaflet';
import { AIRCRAFT_LAYER } from '../../../shared/layers.js';
import { AircraftResponseSchema, type Aircraft, type AircraftResponse, type AdsbSource } from '../../../shared/schemas/aircraft.js';
import { err, ok, type Result } from '../../../shared/result.js';
import { resource } from '../../core/resource.js';
import { effect } from '../../core/signal.js';
import { formatNumber, t } from '../../i18n/index.js';
import { settings } from '../../settings-resource.js';
import { formatAge } from '../../shell/staleness.js';
import { createCanvasGlyphLayer } from './canvasGlyphLayer.js';
import { followTarget, followVessel, isFollowing, stopFollowing, zoomToVessel, type Position } from './follow.js';
import { projectPosition } from './motion.js';
import { buildVesselActions, type VesselActions } from './vesselActions.js';
import { visibleGlyphs, type GlyphDescriptor } from './glyphs.js';
import { AIRCRAFT_GLYPH_COLOR } from './liveLayerColors.js';
import { createTrailLayer } from './trailLayer.js';
import { mapToBboxQuery, mountWhileEnabled, refetchOnMapMove, type LiveLayerCallbacks } from './liveLayerMount.js';

const AIRCRAFT_WIDTH_PX = 18;
const AIRCRAFT_HEIGHT_PX = 24;
/**
 * How long a plane that has dropped out of the feed keeps being drawn,
 * gliding on its last known course.
 *
 * Coverage down low around Vesterålen is thin -- neither ADS-B network
 * holds a contact reliably, and OpenSky's own snapshot only refreshes
 * every 45 seconds -- so an aircraft crossing the map vanishes for a poll
 * or two and returns a few kilometres on. At a 10-second poll this rides
 * out about three consecutive misses, which is what stops the map
 * flickering between "there is a plane" and "there is nothing". Beyond
 * it, the aircraft really has gone (landed, left the box, or out of range
 * for good) and the map should stop claiming otherwise.
 */
const COAST_MS = 30_000;
const HIT_RADIUS_PX = 22; // half of a 44px tap diameter

const METERS_PER_FOOT = 0.3048;
/**
 * Aviation reports ground speed in knots and climb rate in feet per
 * minute; this display is read by people standing in a Norwegian living
 * room, for whom km/h is the speed they have a feel for. Altitude keeps
 * its feet alongside metres because flight levels are what an aircraft
 * actually flies, but the two rates are converted outright.
 */
const KM_PER_HOUR_PER_KNOT = 1.852;
const METERS_PER_SECOND_PER_FOOT_PER_MINUTE = METERS_PER_FOOT / 60;

/**
 * Below this a climb rate is noise, not a climb: an aircraft holding
 * level reports a few tens of feet a minute either way as the barometric
 * altitude jitters, and a popup that flickers between "climbing" and
 * "descending" while a plane sits at its cruise level reads as a fault.
 * 200 ft/min is about 1 m/s.
 */
const LEVEL_FLIGHT_FPM = 200;

async function fetchAircraft(map: Leaflet.Map): Promise<Result<AircraftResponse>> {
    // Same reasoning as `ships.ts`'s own skip -- see `mapToBboxQuery`.
    const bbox = mapToBboxQuery(map);
    if (bbox === null) return err({ message: 'Skipped GET /api/aircraft: the map has no measurable viewport yet' });
    try {
        const response = await fetch(`/api/aircraft?bbox=${bbox}`);
        if (!response.ok) {
            return err({ message: `GET /api/aircraft responded ${String(response.status)}` });
        }
        const json: unknown = await response.json();
        const parsed = AircraftResponseSchema.safeParse(json);
        if (!parsed.success) {
            return err({ message: 'GET /api/aircraft returned a payload that failed schema validation', cause: parsed.error });
        }
        return ok(parsed.data);
    } catch (cause) {
        return err({ message: 'Network error fetching /api/aircraft', cause });
    }
}

/** Display names for the footer credit -- matches how each provider names itself, not this app's internal `AdsbSource` id. */
const ADSB_SOURCE_LABELS: Record<AdsbSource, string> = {
    adsblol: 'adsb.lol',
    airplaneslive: 'airplanes.live',
    adsbfi: 'adsb.fi',
    opensky: 'OpenSky',
};

/**
 * Builds the footer credit from the response's own `sources`, the same
 * `Data: <org> / <org>` shape ships already uses for its two credited
 * organisations. Falls back to the hard-coded constant when `sources` is
 * absent -- an older server, or the BFF's own remembered-aircraft
 * fallback, where no live provider actually answered this request.
 */
function attributionFor(sources: readonly AdsbSource[] | undefined, showsRoutes: boolean): string {
    // adsbdb is credited on the same "what is actually on screen" rule the
    // ADS-B providers are: it is named only while a route it resolved is
    // being drawn, not merely because the BFF is able to ask it.
    const routeCredit = showsRoutes ? ['adsbdb'] : [];
    if (!sources || sources.length === 0) {
        return showsRoutes ? `${AIRCRAFT_LAYER.attribution} / adsbdb` : AIRCRAFT_LAYER.attribution;
    }
    return `Data: ${[...sources.map((source) => ADSB_SOURCE_LABELS[source]), ...routeCredit].join(' / ')}`;
}

function toGlyph(aircraft: Aircraft): GlyphDescriptor<Aircraft> {
    return {
        id: aircraft.icao,
        lat: aircraft.lat,
        lng: aircraft.lng,
        heading: aircraft.track,
        timestamp: aircraft.timestamp,
        data: aircraft,
    };
}

function isOnGround(aircraft: Aircraft): boolean {
    return aircraft.altitudeFt === 'ground';
}

/** An aircraft's callsign for its always-visible label, falling back to its ICAO hex when the callsign is blank -- the exact same fallback `buildAircraftPopup` already uses. Unlike ships, every rendered aircraft gets a label, no status filter. */
function aircraftLabel(aircraft: Aircraft): string {
    const callsign = aircraft.callsign.trim();
    return callsign === '' ? aircraft.icao : callsign;
}

/**
 * The operator, aircraft type and tail number on one line, in that order,
 * skipping whatever this aircraft's feed did not carry -- OpenSky's state
 * vectors have neither type nor registration, and the community feeds
 * have them only for aircraft their own databases know. Empty when none
 * of the three is known, and the caller draws no line at all.
 */
function identityLine(aircraft: Aircraft): string {
    return [aircraft.route?.airline, aircraft.aircraftType, aircraft.registration].filter((part) => part !== undefined && part !== '').join(' · ');
}

/** A route end as the town, with its airport code after it: "Bodø (BOO)" -- the town is what a passer-by reads, the code is what disambiguates it. */
function airportLabel(airport: { code: string; municipality: string }): string {
    return airport.municipality === airport.code ? airport.code : `${airport.municipality} (${airport.code})`;
}

/** "Climbing 6 m/s" / "Descending 3 m/s", or `null` for level flight and for a feed that reports no vertical rate at all. */
function verticalRateLine(aircraft: Aircraft): string | null {
    const fpm = aircraft.verticalRateFpm;
    if (fpm === undefined || Math.abs(fpm) < LEVEL_FLIGHT_FPM) return null;
    // Whole metres a second: the underlying figure is a barometric
    // estimate, and a decimal on it would claim a precision it does not
    // have.
    const rate = formatNumber(Math.round(Math.abs(fpm) * METERS_PER_SECOND_PER_FOOT_PER_MINUTE), t('unit.metersPerSecond'));
    return fpm > 0 ? t('map.aircraftClimbing', { rate }) : t('map.aircraftDescending', { rate });
}

function buildAircraftPopup(aircraft: Aircraft, actions: VesselActions, now: Date = new Date()): HTMLElement {
    const root = document.createElement('div');
    root.className = 'aircraft-popup';

    const callsign = document.createElement('div');
    callsign.className = 'aircraft-popup-callsign';
    callsign.textContent = aircraft.callsign.trim() === '' ? aircraft.icao : aircraft.callsign;
    root.append(callsign);

    const identity = identityLine(aircraft);
    if (identity !== '') {
        const line = document.createElement('div');
        line.className = 'aircraft-popup-identity';
        line.textContent = identity;
        root.append(line);
    }

    // Never part of the broadcast -- see `FlightRouteSchema`. Absent for
    // most aircraft (nothing scheduled has a route to look up), and for a
    // scheduled one whose lookup has not come back yet; in both cases the
    // popup simply has one line fewer.
    if (aircraft.route) {
        const route = document.createElement('div');
        route.className = 'aircraft-popup-route';
        route.textContent = t('map.aircraftRoute', {
            from: airportLabel(aircraft.route.origin),
            to: airportLabel(aircraft.route.destination),
        });
        root.append(route);
    }

    const altitude = document.createElement('div');
    if (aircraft.altitudeFt === 'ground') {
        altitude.textContent = t('map.aircraftOnGround');
    } else {
        const feet = aircraft.altitudeFt;
        const meters = feet * METERS_PER_FOOT;
        altitude.textContent = t('map.aircraftAltitude', {
            feet: formatNumber(feet, t('unit.feet')),
            meters: formatNumber(meters, t('unit.meters')),
        });
    }
    root.append(altitude);

    const speed = document.createElement('div');
    speed.textContent = t('map.aircraftSpeed', {
        // Whole km/h: converting knots leaves three decimals otherwise,
        // and nobody reads a ground speed to the metre per hour.
        speed: formatNumber(Math.round(aircraft.groundSpeedKt * KM_PER_HOUR_PER_KNOT), t('unit.kilometersPerHour')),
    });
    root.append(speed);

    const track = document.createElement('div');
    track.textContent = t('map.aircraftTrack', { track: formatNumber(aircraft.track, t('unit.degrees')) });
    root.append(track);

    const verticalRate = verticalRateLine(aircraft);
    if (verticalRate !== null) {
        const climb = document.createElement('div');
        climb.textContent = verticalRate;
        root.append(climb);
    }

    const age = document.createElement('div');
    age.textContent = t('map.popupUpdated', { age: formatAge(new Date(aircraft.timestamp), now) });
    root.append(age);

    root.append(buildVesselActions(actions));

    return root;
}

export function mountAircraftLayer(L: typeof Leaflet, map: Leaflet.Map, callbacks: LiveLayerCallbacks): () => void {
    return mountWhileEnabled(
        () => settings.get().aircraft.enabled,
        () => {
            let latestAircraft: readonly Aircraft[] = [];

            /**
             * Where an aircraft is right now -- its last fix carried
             * forward on its own track and ground speed, the same dead
             * reckoning the glyph is drawn with (`motion.ts`). At 500km/h
             * a fix ten seconds old is well over a kilometre stale, so a
             * follow that used the raw fix would trail the plane by most
             * of the screen.
             */
            function aircraftPosition(icao: string): Position | undefined {
                const aircraft = latestAircraft.find((candidate) => candidate.icao === icao);
                if (!aircraft) return undefined;
                const fixMs = Date.parse(aircraft.timestamp);
                if (Number.isNaN(fixMs)) return { lat: aircraft.lat, lng: aircraft.lng };
                return projectPosition(
                    { lat: aircraft.lat, lng: aircraft.lng },
                    { speedKt: aircraft.groundSpeedKt, courseDeg: aircraft.track },
                    Date.now() - fixMs,
                );
            }

            /** Same shape, and the same close-the-popup-first reasoning, as `ships.ts`'s. */
            function aircraftActions(aircraft: Aircraft): VesselActions {
                return {
                    following: isFollowing(aircraft.icao),
                    onZoomTo: (): void => {
                        const at = aircraftPosition(aircraft.icao);
                        map.closePopup();
                        if (at) zoomToVessel(map, at);
                    },
                    onToggleFollow: (): void => {
                        const wasFollowing = isFollowing(aircraft.icao);
                        map.closePopup();
                        if (wasFollowing) {
                            stopFollowing();
                            return;
                        }
                        followVessel(map, { id: aircraft.icao, label: aircraftLabel(aircraft) }, () => aircraftPosition(aircraft.icao));
                    },
                };
            }

            const canvasLayer = createCanvasGlyphLayer<Aircraft>(L, map, {
                color: AIRCRAFT_GLYPH_COLOR,
                widthPx: AIRCRAFT_WIDTH_PX,
                heightPx: AIRCRAFT_HEIGHT_PX,
                hitRadiusPx: HIT_RADIUS_PX,
                shape: 'plane',
                buildPopup: (aircraft) => buildAircraftPopup(aircraft, aircraftActions(aircraft)),
                isDistinct: isOnGround,
                labelFor: (aircraft) => aircraftLabel(aircraft),
                // ADS-B's `track` is course over ground already, and
                // `groundSpeedKt` the speed to match it. An aircraft
                // sitting on a stand reports 0 and so does not move.
                velocityFor: (aircraft) => ({ speedKt: aircraft.groundSpeedKt, courseDeg: aircraft.track }),
                coastMs: COAST_MS,
            });

            const trailLayer = createTrailLayer<Aircraft>(L, map, {
                color: AIRCRAFT_GLYPH_COLOR,
                trailFor: (item) => item.trail,
                // The same accessor the glyph layer gets, so the tail's
                // leading end tracks the plane rather than its last fix.
                velocityFor: (aircraft) => ({ speedKt: aircraft.groundSpeedKt, courseDeg: aircraft.track }),
            });

            const pollSeconds = Math.max(settings.get().aircraft.pollSeconds, AIRCRAFT_LAYER.minPollSeconds);
            const res = resource(() => fetchAircraft(map), { intervalMs: pollSeconds * 1000 });

            function clear(): void {
                latestAircraft = [];
                canvasLayer.clear();
                trailLayer.clear();
                callbacks.reportCount(0, 0);
                callbacks.reportItems([]);
                callbacks.reportAttribution(undefined);
            }

            const disposeEffect = effect(() => {
                const state = res.state.get();
                if (state.status !== 'ready') return;
                if (!state.data.configured) {
                    clear();
                    return;
                }
                const showOnGround = settings.get().aircraft.showOnGround;
                const items = showOnGround ? state.data.aircraft : state.data.aircraft.filter((aircraft) => !isOnGround(aircraft));
                latestAircraft = items;
                const now = new Date();
                const maxAgeMinutes = settings.get().aircraft.maxAgeMinutes;
                const glyphs = items.map(toGlyph);
                canvasLayer.update(glyphs, maxAgeMinutes, now);
                trailLayer.update(glyphs, now);

                // The same age filter the canvas layer applies, computed
                // here too so the masthead's list offers only aircraft that
                // are actually drawn -- listing one the map is hiding
                // sends a tap to empty sky. `items` is everything the BFF
                // returned (less any on-ground aircraft the viewer chose
                // to hide, which is not an age matter), so the difference
                // is what the age filter held back.
                const visible = visibleGlyphs(glyphs, maxAgeMinutes, now);
                callbacks.reportCount(visible.length, items.length - visible.length);
                callbacks.reportItems(
                    visible.map(({ descriptor }) => ({
                        id: descriptor.id,
                        label: aircraftLabel(descriptor.data),
                        detail:
                            descriptor.data.altitudeFt === 'ground'
                                ? t('map.aircraftOnGround')
                                : t('map.aircraftAltitudeShort', { feet: formatNumber(descriptor.data.altitudeFt, t('unit.feet')) }),
                        lat: descriptor.lat,
                        lng: descriptor.lng,
                    })),
                );
                callbacks.reportAttribution(
                    attributionFor(
                        state.data.sources,
                        visible.some(({ descriptor }) => descriptor.data.route !== undefined),
                    ),
                );
            });

            const disposeMoveRefetch = refetchOnMapMove(map, () => {
                res.refresh();
            });

            // See the matching effect in `ships.ts`: an open popup's follow
            // button has to keep up with a follow that started or stopped
            // somewhere else.
            const disposeFollowSync = effect(() => {
                followTarget.get();
                canvasLayer.refreshOpenPopup();
            });

            return function dispose(): void {
                disposeEffect();
                disposeFollowSync();
                disposeMoveRefetch();
                res.dispose();
                canvasLayer.dispose();
                trailLayer.dispose();
                callbacks.reportCount(0, 0);
                callbacks.reportItems([]);
                callbacks.reportAttribution(undefined);
            };
        },
    );
}
