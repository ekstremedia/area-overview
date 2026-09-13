/**
 * The Veg (Statens vegvesen) road-situations live layer: polls
 * `GET /api/road-situations?bbox=` for the map's current viewport and
 * draws one pin per situation -- a vegmelding, already grouped
 * server-side from upstream's main + consequence records -- plus a line
 * along the stretch for the situations whose extent means something.
 * Mounted only through `layers.ts`'s `mountLiveLayers`.
 *
 * Two axes, deliberately independent (see `liveLayerColors.ts`):
 *
 *  - the **sign face** on the pin says what kind of thing it is (110
 *    Vegarbeid, 302 Innkjøring forbudt, 775 Bilferje, 156 Annen fare),
 *    and a closure overrides the cause -- "shut" is the fact read across
 *    the room, whether it was roadworks, a rockfall or an accident that
 *    shut it;
 *  - the **colour** says what state it is in: red closed, amber in force,
 *    grey not in force right now.
 *
 * `showPlanned` is a *client-side* filter. The response always carries
 * `scheduled` and `planned` alongside `current`, so the BFF's single
 * cache entry per rounded bbox serves both preferences -- moving the
 * filter server-side would double the cache keys to answer a question
 * the browser can answer for free.
 *
 * Unlike ships and aircraft this layer is pins and lines, not canvas
 * glyphs: a road situation does not move, has no heading, and its pin is
 * a piece of real artwork that has to be DOM (`L.divIcon`) for `map.css`
 * to size and colour it. The lines do go through the map's one shared
 * `L.Canvas` (`canvasRenderer.ts`) -- a second renderer is a second
 * full-size canvas, and the topmost canvas eats every tap.
 *
 * Everything is diffed by `id` across polls (`setLatLng`/`setIcon`/
 * `setStyle`, popup content refreshed while open), never rebuilt: a
 * rebuild would close an open popup every two minutes and churn a
 * marker per situation for data that mostly did not change.
 */
import type * as Leaflet from 'leaflet';
import { ROADS_LAYER } from '../../../shared/layers.js';
import { RoadSituationsResponseSchema, type RoadSituation, type RoadSituationsResponse } from '../../../shared/schemas/roads.js';
import { err, ok, type Result } from '../../../shared/result.js';
import { resource } from '../../core/resource.js';
import { effect } from '../../core/signal.js';
import { currentLanguage, formatShortDate, formatTime, t, type ParamlessKey } from '../../i18n/index.js';
import { settings } from '../../settings-resource.js';
import { formatAge } from '../../shell/staleness.js';
import { sharedCanvasRenderer } from './canvasRenderer.js';
import { ROAD_CLOSED_COLOR, ROAD_CURRENT_COLOR, ROAD_LINE_CASING_COLOR, ROAD_PLANNED_COLOR } from './liveLayerColors.js';
import { mapToBboxQuery, mountWhileEnabled, refetchOnMapMove, type LiveLayerCallbacks } from './liveLayerMount.js';
import { formatRoadNumber } from './roadNumber.js';
/*
 * The real Vegvesen sign faces, inlined at build time (`?raw`) rather
 * than fetched as four more requests: a pin has to appear with the
 * marker, not a network round trip later, and the four together are
 * smaller than one camera still. Source, licence (NLOD), åndsverkloven
 * § 14 and why they are never rendered full-bleed: `signs/README.md`.
 */
import signRoadworks from './signs/110.svg?raw';
import signClosed from './signs/302.svg?raw';
import signFerry from './signs/775.svg?raw';
import signGeneric from './signs/156.svg?raw';

/** The full 44px tap-target minimum; the visible plate inside it is smaller (`map.css`), exactly as the ship cluster badge does it. */
const ROAD_PIN_PX = 44;

/** The CSS custom property `map.css`'s pin rules read the state colour from -- set inline on the pin's own element, the same "colour from JS, shape from CSS" split `UNDERWAY_COLOR_PROPERTY` uses in `ships.ts`. */
const ROAD_COLOR_PROPERTY = '--road-situation-color';

/** Dark outline under the coloured core, so the line survives the satellite and dark basemaps alike. */
const LINE_CASING_WEIGHT = 7;
const LINE_CORE_WEIGHT = 4;
/** Dashes mean "not in force right now" -- the same distinction the grey carries, said twice because a thin line's colour is the first thing lost on a busy basemap. */
const LINE_PLANNED_DASH = '10 8';

async function fetchRoadSituations(map: Leaflet.Map): Promise<Result<RoadSituationsResponse>> {
    // No usable viewport (see `mapToBboxQuery`). An error, not an empty
    // answer, so `resource` keeps the situations already drawn -- exactly
    // `ships.ts`'s reasoning.
    const bbox = mapToBboxQuery(map);
    if (bbox === null) return err({ message: 'Skipped GET /api/road-situations: the map has no measurable viewport yet' });
    try {
        const response = await fetch(`/api/road-situations?bbox=${bbox}`);
        // 503 carries the documented `{configured:false}` body, which is a
        // valid response rather than a failure -- see `ships.ts`.
        if (!response.ok && response.status !== 503) {
            return err({ message: `GET /api/road-situations responded ${String(response.status)}` });
        }
        const json: unknown = await response.json();
        const parsed = RoadSituationsResponseSchema.safeParse(json);
        if (!parsed.success) {
            return err({ message: 'GET /api/road-situations returned a payload that failed schema validation', cause: parsed.error });
        }
        return ok(parsed.data);
    } catch (cause) {
        return err({ message: 'Network error fetching /api/road-situations', cause });
    }
}

/**
 * The sign face for a situation: closure first, then the kind. A closed
 * road is 302 whatever shut it -- the cause is in the popup, and the one
 * thing a passer-by must get from the pin alone is that the road is not
 * usable.
 */
export function signFor(situation: RoadSituation): string {
    if (situation.closed) return signClosed;
    if (situation.kind === 'roadworks') return signRoadworks;
    if (situation.kind === 'ferry') return signFerry;
    return signGeneric;
}

/** Red shut, amber in force, grey not in force now. See `liveLayerColors.ts` for why the two axes are separate. */
export function colorFor(situation: RoadSituation): string {
    if (situation.closed) return ROAD_CLOSED_COLOR;
    return situation.status === 'current' ? ROAD_CURRENT_COLOR : ROAD_PLANNED_COLOR;
}

const KIND_LABEL_KEYS: Readonly<Record<RoadSituation['kind'], ParamlessKey>> = {
    roadworks: 'map.roadKind.roadworks',
    obstruction: 'map.roadKind.obstruction',
    weather: 'map.roadKind.weather',
    accident: 'map.roadKind.accident',
    ferry: 'map.roadKind.ferry',
    event: 'map.roadKind.event',
    management: 'map.roadKind.management',
    other: 'map.roadKind.other',
};

/**
 * The handful of Datex II effect codes seen on a live Vesterålen
 * viewport, in words. Everything else falls through to `humaniseEffect`
 * rather than being hidden: the schema's own contract is that an unknown
 * effect "simply shows as itself", because a chip nobody translated yet
 * still tells a reader more than a missing chip does.
 */
const EFFECT_LABEL_KEYS: Readonly<Record<string, ParamlessKey | undefined>> = {
    roadClosed: 'map.roadEffect.roadClosed',
    intermittentShortTermClosures: 'map.roadEffect.intermittentShortTermClosures',
    laneClosures: 'map.roadEffect.laneClosures',
    narrowLanes: 'map.roadEffect.narrowLanes',
    contraflow: 'map.roadEffect.contraflow',
    temporaryTrafficLights: 'map.roadEffect.temporaryTrafficLights',
    trafficBeingManuallyDirected: 'map.roadEffect.trafficBeingManuallyDirected',
};

/** `"someUnknownEffect"` -> `"some unknown effect"`: upstream's codes are camelCase English enums, and spacing them is the least-wrong way to show one nobody has translated. */
function humaniseEffect(effect: string): string {
    const spaced = effect.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function effectLabel(effect: string): string {
    const key = EFFECT_LABEL_KEYS[effect];
    return key === undefined ? humaniseEffect(effect) : t(key);
}

/** "14. sep. 06:00" -- a short date and a 24-hour clock, both through `Intl` so the English UI reads "14 Sep 06:00". */
function formatMoment(iso: string): string {
    const date = new Date(iso);
    return `${formatShortDate(date)} ${formatTime(date)}`;
}

/**
 * The validity line: when this ends, or that it does not.
 *
 * A `planned` situation says when it *starts* instead -- "fra 15. sep
 * 08:00" -- since that is the question its pin raises. Note what is
 * missing: the plan asked for "gyldig 08:30-21:00" for a periodic
 * situation, but `RoadSituationSchema` carries only `periodic: boolean`,
 * not the period clock times, so the daily hours cannot be shown without
 * a contract change (Phase A is committed and reviewed). The periodic
 * case says that it applies in periods, and leaves the hours to the
 * description, which is where upstream writes them anyway.
 */
function validityText(situation: RoadSituation): string {
    if (situation.status === 'planned') return t('map.roadValidFrom', { when: formatMoment(situation.startsAt) });
    if (situation.endsAt === null) return t('map.roadValidOpenEnded');
    return t('map.roadValidUntil', { when: formatMoment(situation.endsAt) });
}

/** The sign face as an inline element, sized by `className` alone so the same markup serves the 32px pin and the 48px popup heading. */
function signElement(situation: RoadSituation, className: string): HTMLElement {
    const holder = document.createElement('span');
    holder.className = className;
    // A vendored, build-time constant (`signs/*.svg`), never anything that
    // came off the wire -- the situation's own fields all go in through
    // `textContent` below.
    holder.innerHTML = signFor(situation);
    // The sign is decoration for the text beside it; a screen reader
    // reading out a traced path's title would add nothing.
    holder.setAttribute('aria-hidden', 'true');
    return holder;
}

export function buildRoadPopup(situation: RoadSituation, now: Date = new Date()): HTMLElement {
    const root = document.createElement('div');
    root.className = 'road-popup';

    const head = document.createElement('div');
    head.className = 'road-popup-head';
    head.append(signElement(situation, 'road-popup-sign'));

    const heading = document.createElement('div');
    heading.className = 'road-popup-heading';

    const kind = document.createElement('div');
    kind.className = 'road-popup-kind';
    kind.textContent = t(KIND_LABEL_KEYS[situation.kind]);
    kind.style.setProperty(ROAD_COLOR_PROPERTY, colorFor(situation));
    heading.append(kind);

    // Road number and place, in the order a Norwegian road report says
    // them ("Fv. 7542, Glåmvika"), with either half omitted when upstream
    // carried none.
    const where = [formatRoadNumber(situation.roadNumber), situation.location].filter((part) => part !== null && part !== '').join(' · ');
    if (where !== '') {
        const line = document.createElement('div');
        line.className = 'road-popup-where';
        line.textContent = where;
        heading.append(line);
    }
    head.append(heading);
    root.append(head);

    /*
     * Vegvesen's own Norwegian text, verbatim, in both UI languages: the
     * NPRA terms for this data state that the Norwegian messages may not
     * be translated. Under the English UI a small "Statens vegvesen" line
     * follows it, so the untranslated paragraph reads as a quoted source
     * note rather than as a bug in the language switch.
     */
    const description = document.createElement('p');
    description.className = 'road-popup-description';
    description.textContent = situation.description;
    root.append(description);

    if (currentLanguage.get() === 'en') {
        const source = document.createElement('div');
        source.className = 'road-popup-source';
        source.textContent = t('map.roadSource');
        root.append(source);
    }

    if (situation.effects.length > 0) {
        const effects = document.createElement('ul');
        effects.className = 'road-popup-effects';
        for (const effect of situation.effects) {
            const chip = document.createElement('li');
            chip.className = 'road-popup-effect';
            chip.textContent = effectLabel(effect);
            effects.append(chip);
        }
        root.append(effects);
    }

    const validity = document.createElement('div');
    validity.className = 'road-popup-validity';
    validity.textContent = situation.periodic ? `${validityText(situation)} · ${t('map.roadPeriodic')}` : validityText(situation);
    root.append(validity);

    if (situation.status !== 'current') {
        const status = document.createElement('div');
        status.className = 'road-popup-status';
        status.textContent = situation.status === 'planned' ? t('map.roadStatus.planned') : t('map.roadStatus.scheduled');
        root.append(status);
    }

    const updated = document.createElement('div');
    updated.className = 'road-popup-updated';
    updated.textContent = t('map.popupUpdated', { age: formatAge(new Date(situation.updatedAt), now) });
    root.append(updated);

    return root;
}

function buildRoadPinIcon(L: typeof Leaflet, situation: RoadSituation): Leaflet.DivIcon {
    const plate = document.createElement('span');
    plate.className = 'road-pin-plate';
    plate.style.setProperty(ROAD_COLOR_PROPERTY, colorFor(situation));
    plate.append(signElement(situation, 'road-pin-sign'));
    return L.divIcon({
        className: 'road-pin',
        html: plate,
        iconSize: [ROAD_PIN_PX, ROAD_PIN_PX],
        iconAnchor: [ROAD_PIN_PX / 2, ROAD_PIN_PX / 2],
    });
}

/**
 * What the pin's artwork is derived from. Two situations agreeing on all
 * three render the identical icon, so a poll that only moved the clock
 * on does not rebuild a single `L.DivIcon`.
 */
function iconKeyOf(situation: RoadSituation): string {
    return `${situation.kind}:${String(situation.closed)}:${situation.status}`;
}

/** Cheap structural identity for the drawn geometry -- `null` (no line) included, so a situation that gains or loses one is caught. */
function lineKeyOf(situation: RoadSituation): string {
    return JSON.stringify(situation.line);
}

interface RoadEntry {
    marker: Leaflet.Marker;
    /** Casing/core pairs, one pair per `LineString` in `situation.line`. Empty for a pin-only situation. */
    lines: Leaflet.Polyline[];
    situation: RoadSituation;
    iconKey: string;
    lineKey: string;
}

export function mountRoadsLayer(L: typeof Leaflet, map: Leaflet.Map, callbacks: LiveLayerCallbacks): () => void {
    return mountWhileEnabled(
        () => settings.get().roads.enabled,
        () => {
            const renderer = sharedCanvasRenderer(L, map);
            const layerGroup = L.layerGroup().addTo(map);
            const entries = new Map<string, RoadEntry>();

            /**
             * Reads the *current* situation for `id` out of `entries`, not
             * the one captured when the popup was bound -- a popup opened
             * now, on a marker created three polls ago, must show what the
             * last poll said.
             */
            function popupFor(id: string, fallback: RoadSituation): HTMLElement {
                return buildRoadPopup(entries.get(id)?.situation ?? fallback);
            }

            function bindPopup(layer: Leaflet.Marker | Leaflet.Polyline, situation: RoadSituation): void {
                // The line and the pin carry the same popup content, so a
                // tap anywhere along a closed stretch answers the same
                // question the pin at its display point does.
                layer.bindPopup(() => popupFor(situation.id, situation), {
                    className: 'road-popup-wrapper',
                    autoPanPadding: [20, 20],
                });
            }

            function drawLines(situation: RoadSituation): Leaflet.Polyline[] {
                if (situation.line === null) return [];
                const color = colorFor(situation);
                const dashed = situation.status !== 'current';
                const lines: Leaflet.Polyline[] = [];
                for (const path of situation.line) {
                    if (path.length < 2) continue;
                    const casing = L.polyline(path, {
                        renderer,
                        color: ROAD_LINE_CASING_COLOR,
                        weight: LINE_CASING_WEIGHT,
                        // Scenery under the core: it must never take the tap
                        // the core is there to receive.
                        interactive: false,
                    });
                    casing.addTo(layerGroup);
                    const core = L.polyline(path, {
                        renderer,
                        color,
                        weight: LINE_CORE_WEIGHT,
                        ...(dashed ? { dashArray: LINE_PLANNED_DASH } : {}),
                    });
                    bindPopup(core, situation);
                    core.addTo(layerGroup);
                    lines.push(casing, core);
                }
                return lines;
            }

            function restyleLines(entry: RoadEntry): void {
                const color = colorFor(entry.situation);
                const dashed = entry.situation.status !== 'current';
                entry.lines.forEach((line, index) => {
                    // Even indices are casings (see `drawLines`): they stay
                    // the fixed dark outline whatever the state is.
                    if (index % 2 === 0) return;
                    line.setStyle({ color, dashArray: dashed ? LINE_PLANNED_DASH : undefined });
                });
            }

            function removeLines(entry: RoadEntry): void {
                for (const line of entry.lines) layerGroup.removeLayer(line);
                entry.lines = [];
            }

            function addEntry(situation: RoadSituation): void {
                const marker = L.marker([situation.point.lat, situation.point.lng], { icon: buildRoadPinIcon(L, situation) });
                bindPopup(marker, situation);
                marker.addTo(layerGroup);
                entries.set(situation.id, {
                    marker,
                    lines: drawLines(situation),
                    situation,
                    iconKey: iconKeyOf(situation),
                    lineKey: lineKeyOf(situation),
                });
            }

            function updateEntry(entry: RoadEntry, situation: RoadSituation): void {
                entry.situation = situation;
                entry.marker.setLatLng([situation.point.lat, situation.point.lng]);

                const iconKey = iconKeyOf(situation);
                if (iconKey !== entry.iconKey) {
                    entry.marker.setIcon(buildRoadPinIcon(L, situation));
                    entry.iconKey = iconKey;
                }

                const lineKey = lineKeyOf(situation);
                if (lineKey !== entry.lineKey) {
                    // The geometry itself changed (roadworks re-surveyed, a
                    // closure extended): the pair count can change with it,
                    // so these are redrawn rather than moved point by point.
                    removeLines(entry);
                    entry.lines = drawLines(situation);
                    entry.lineKey = lineKey;
                } else {
                    // Same geometry, possibly a new state: colour and dash
                    // are a `setStyle` on paths already in the canvas.
                    restyleLines(entry);
                }

                // An open popup is refreshed in place; a closed one rebuilds
                // from `entries` the next time it opens (see `popupFor`).
                if (entry.marker.isPopupOpen()) entry.marker.setPopupContent(buildRoadPopup(situation));
                for (const line of entry.lines) {
                    if (line.isPopupOpen()) line.setPopupContent(buildRoadPopup(situation));
                }
            }

            function removeEntry(id: string): void {
                const entry = entries.get(id);
                if (!entry) return;
                removeLines(entry);
                layerGroup.removeLayer(entry.marker);
                entries.delete(id);
            }

            function clear(): void {
                for (const id of [...entries.keys()]) removeEntry(id);
                callbacks.reportCount(0, 0);
                callbacks.reportItems([]);
                callbacks.reportAttribution(undefined);
            }

            const pollSeconds = Math.max(settings.get().roads.pollSeconds, ROADS_LAYER.minPollSeconds);
            const res = resource(() => fetchRoadSituations(map), { intervalMs: pollSeconds * 1000 });

            const disposeEffect = effect(() => {
                const state = res.state.get();
                if (state.status !== 'ready') return;
                if (!state.data.configured) {
                    clear();
                    return;
                }

                // Read inside the effect, so flipping "Vis planlagt
                // vegarbeid" re-filters what is already on screen instead of
                // waiting up to ten minutes for the next poll.
                const showPlanned = settings.get().roads.showPlanned;
                const visible = showPlanned ? state.data.situations : state.data.situations.filter((situation) => situation.status === 'current');

                const wanted = new Set(visible.map((situation) => situation.id));
                for (const id of [...entries.keys()]) {
                    if (!wanted.has(id)) removeEntry(id);
                }
                for (const situation of visible) {
                    const entry = entries.get(situation.id);
                    if (entry) updateEntry(entry, situation);
                    else addEntry(situation);
                }

                // The masthead counts what is **in force now**, always --
                // deliberately not `visible.length`. A number that silently
                // changes meaning when "Vis planlagt vegarbeid" is switched
                // on is a number nobody can trust from across the room:
                // "6 vegmeldinger" has to mean six things happening, not
                // six things of which four are next month's roadworks.
                // The tap-through list below still shows everything the map
                // is drawing, which is what that list is for.
                //
                // Counted from the response rather than from `visible` so
                // "always" is true by construction and not by the two
                // branches above happening to agree.
                //
                // No age filter on this layer -- a road notice is valid
                // until it expires, and an expired one never leaves the BFF
                // -- so nothing is ever hidden by age.
                const currentCount = state.data.situations.filter((situation) => situation.status === 'current').length;
                callbacks.reportCount(currentCount, 0);
                callbacks.reportItems(
                    visible.map((situation) => ({
                        id: situation.id,
                        label: formatRoadNumber(situation.roadNumber) ?? t(KIND_LABEL_KEYS[situation.kind]),
                        detail: situation.location ?? t(KIND_LABEL_KEYS[situation.kind]),
                        lat: situation.point.lat,
                        lng: situation.point.lng,
                    })),
                );
                callbacks.reportAttribution(ROADS_LAYER.attribution);
            });

            const disposeMoveRefetch = refetchOnMapMove(map, () => {
                res.refresh();
            });

            return function dispose(): void {
                disposeEffect();
                disposeMoveRefetch();
                res.dispose();
                for (const id of [...entries.keys()]) removeEntry(id);
                map.removeLayer(layerGroup);
                callbacks.reportCount(0, 0);
                callbacks.reportItems([]);
                callbacks.reportAttribution(undefined);
            };
        },
    );
}
