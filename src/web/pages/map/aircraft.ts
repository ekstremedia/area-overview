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
function attributionFor(sources: readonly AdsbSource[] | undefined): string {
    if (!sources || sources.length === 0) return AIRCRAFT_LAYER.attribution;
    return `Data: ${sources.map((source) => ADSB_SOURCE_LABELS[source]).join(' / ')}`;
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

function buildAircraftPopup(aircraft: Aircraft, now: Date = new Date()): HTMLElement {
    const root = document.createElement('div');
    root.className = 'aircraft-popup';

    const callsign = document.createElement('div');
    callsign.className = 'aircraft-popup-callsign';
    callsign.textContent = aircraft.callsign.trim() === '' ? aircraft.icao : aircraft.callsign;
    root.append(callsign);

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
    speed.textContent = t('map.aircraftSpeed', { speed: formatNumber(aircraft.groundSpeedKt, t('unit.knots')) });
    root.append(speed);

    const track = document.createElement('div');
    track.textContent = t('map.aircraftTrack', { track: formatNumber(aircraft.track, t('unit.degrees')) });
    root.append(track);

    const age = document.createElement('div');
    age.textContent = t('map.popupUpdated', { age: formatAge(new Date(aircraft.timestamp), now) });
    root.append(age);

    return root;
}

export function mountAircraftLayer(L: typeof Leaflet, map: Leaflet.Map, callbacks: LiveLayerCallbacks): () => void {
    return mountWhileEnabled(
        () => settings.get().aircraft.enabled,
        () => {
            const canvasLayer = createCanvasGlyphLayer<Aircraft>(L, map, {
                color: AIRCRAFT_GLYPH_COLOR,
                widthPx: AIRCRAFT_WIDTH_PX,
                heightPx: AIRCRAFT_HEIGHT_PX,
                hitRadiusPx: HIT_RADIUS_PX,
                shape: 'plane',
                buildPopup: (aircraft) => buildAircraftPopup(aircraft),
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
                callbacks.reportAttribution(attributionFor(state.data.sources));
            });

            const disposeMoveRefetch = refetchOnMapMove(map, () => {
                res.refresh();
            });

            return function dispose(): void {
                disposeEffect();
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
