/**
 * The Warnings live layer: polls `GET /api/warnings?bbox=` for the map's
 * current viewport and draws MET Alerts weather-warning polygons and NVE
 * Varsom avalanche-region outlines+pins, behind the one `warnings` toggle
 * (`WARNINGS_LAYER` in `shared/layers.ts` explains why the two upstreams
 * share it). Mounted only through `layers.ts`'s `mountLiveLayers`.
 *
 * Unlike `transit.ts`/`roads.ts`, this layer does **not** diff by id across
 * polls: it rebuilds its whole `L.layerGroup` from scratch on every poll
 * (`layerGroup.clearLayers()`, then redraw). That is a deliberate choice,
 * not an oversight -- `WARNINGS_LAYER.minPollSeconds` is 300s and the
 * default is 600s, so a poll firing every five-to-ten minutes for data
 * that itself changes a handful of times a day does not need the
 * `Map<id, entry>`/`setLatLng`/`setIcon` machinery `transit.ts` and
 * `roads.ts` earn back on a 15-120s cadence. The one visible cost is an
 * open popup closing every poll; at this cadence that is a rare and cheap
 * inconvenience, not the "flicker every two minutes" `roads.ts`'s own doc
 * comment warns against avoiding.
 *
 * Both weather polygons and avalanche outlines go through the map's one
 * shared `L.Canvas` (`canvasRenderer.ts`) -- the same reason `roads.ts`'s
 * lines do: a second renderer is a second full-size canvas, and the
 * topmost one would eat every tap aimed at a ship or aircraft glyph
 * underneath it. The avalanche pins and MET Alerts popups are ordinary
 * `L.divIcon`/`L.Marker`/`L.Popup` DOM, like every other pin in this app.
 *
 * `settings.warnings.showAvalanche` is a client-side mode filter (mirrors
 * `transit.ts`'s `showBuses`/`showFerries`): the response always carries
 * both upstreams in the one bbox query, and hiding NVE's regions costs no
 * extra request. The masthead count follows what is actually drawn (the
 * same convention `transit.ts` uses, not `roads.ts`'s "always count
 * current" exception -- that one exists because `showPlanned` is a filter
 * on *time*, and this one is a filter on *kind*, exactly the same
 * reasoning that makes `showBuses`/`showFerries` filter the transit count
 * too).
 *
 * Half-failure (`weatherWarnings`/`avalancheWarnings` independently
 * `null` -- see `WarningsResponseSchema`'s doc comment) is handled by
 * defaulting each half to `[]` for rendering **independently**: neither
 * half's absence is examined while building the other, so a MET outage
 * never blanks NVE's regions and vice versa.
 */
import type * as Leaflet from 'leaflet';
import { WARNINGS_LAYER } from '../../../shared/layers.js';
import { WarningsResponseSchema, type AvalancheWarning, type WarningsResponse, type WeatherWarning } from '../../../shared/schemas/warnings.js';
import { err, ok, type Result } from '../../../shared/result.js';
import { resource } from '../../core/resource.js';
import { effect } from '../../core/signal.js';
import { formatShortDate, formatTime, t } from '../../i18n/index.js';
import { settings } from '../../settings-resource.js';
import { formatAge } from '../../shell/staleness.js';
import type { LiveLayerItem } from '../../shell/page-status.js';
import { sharedCanvasRenderer } from './canvasRenderer.js';
import { AVALANCHE_NEUTRAL_COLOR, WARNING_ORANGE_COLOR, WARNING_RED_COLOR, WARNING_UNKNOWN_COLOR, WARNING_YELLOW_COLOR } from './liveLayerColors.js';
import { mapToBboxQuery, mountWhileEnabled, refetchOnMapMove, type LiveLayerCallbacks } from './liveLayerMount.js';
/*
 * Original artwork for this project, not vendored -- see
 * `glyphs/README.md`, same convention `transit.ts`'s bus/ferry glyphs
 * follow.
 */
import avalancheGlyph from './glyphs/avalanche.svg?raw';

/** The full 44px tap-target minimum, same arrangement as `roads.ts`'s `ROAD_PIN_PX`/`transit.ts`'s `TRANSIT_PIN_PX`. */
const AVALANCHE_PIN_PX = 44;

/** The CSS custom property `map.css`'s avalanche pin rules read the danger-level colour from. */
const AVALANCHE_COLOR_PROPERTY = '--avalanche-danger-color';

/** The CSS custom property `map.css`'s MET Alerts popup heading reads its awareness colour from. */
const WARNING_COLOR_PROPERTY = '--warning-awareness-color';

type ConfiguredWarnings = Extract<WarningsResponse, { configured: true }>;

async function fetchWarnings(map: Leaflet.Map): Promise<Result<WarningsResponse>> {
    // No usable viewport (see `mapToBboxQuery`). An error, not an empty
    // answer, so `resource` keeps whatever is already drawn.
    const bbox = mapToBboxQuery(map);
    if (bbox === null) return err({ message: 'Skipped GET /api/warnings: the map has no measurable viewport yet' });
    try {
        const response = await fetch(`/api/warnings?bbox=${bbox}`);
        // 503 carries the documented `{configured:false}` body, which is a
        // valid response rather than a failure -- see `roads.ts`.
        if (!response.ok && response.status !== 503) {
            return err({ message: `GET /api/warnings responded ${String(response.status)}` });
        }
        const json: unknown = await response.json();
        const parsed = WarningsResponseSchema.safeParse(json);
        if (!parsed.success) {
            return err({ message: 'GET /api/warnings returned a payload that failed schema validation', cause: parsed.error });
        }
        return ok(parsed.data);
    } catch (cause) {
        return err({ message: 'Network error fetching /api/warnings', cause });
    }
}

/**
 * MET's `riskMatrixColor`-derived `awarenessLevel`, in the three tiers seen
 * in practice. `extractAwarenessLevel` (`met-alerts.ts`) always lower-cases
 * this value before it reaches the wire, so this map is keyed lowercase to
 * match the real payload shape -- looking it up case-insensitively here too
 * is cheap insurance against a future caller that does not normalise.
 * `WeatherWarningSchema` deliberately keeps this a passthrough string rather
 * than a closed enum precisely so a value MET adds later does not fail the
 * whole response -- this map is where the documented fallback
 * (`WARNING_UNKNOWN_COLOR`) for that case lives.
 */
const MET_AWARENESS_COLORS: Readonly<Record<string, string>> = {
    yellow: WARNING_YELLOW_COLOR,
    orange: WARNING_ORANGE_COLOR,
    red: WARNING_RED_COLOR,
};

function colorForAwareness(level: string): string {
    return MET_AWARENESS_COLORS[level.toLowerCase()] ?? WARNING_UNKNOWN_COLOR;
}

/** The European avalanche danger scale, 1-5: 1 is "no tint" (neutral/grey), 2 yellow, 3 orange, 4-5 both the same red -- NVE's own scale draws no distinction the map needs a fifth colour for. */
function colorForDangerLevel(level: number): string {
    if (level <= 1) return AVALANCHE_NEUTRAL_COLOR;
    if (level === 2) return WARNING_YELLOW_COLOR;
    if (level === 3) return WARNING_ORANGE_COLOR;
    return WARNING_RED_COLOR;
}

/** Where a colour from this module's own palette ranks, for `worstColorOf` below. Deliberately excludes `AVALANCHE_NEUTRAL_COLOR`: level-1 danger never contributes a colour at all (see `render`'s own comment), so it never reaches here. */
const COLOR_SEVERITY: Readonly<Record<string, number>> = {
    [WARNING_YELLOW_COLOR]: 1,
    [WARNING_ORANGE_COLOR]: 2,
    [WARNING_RED_COLOR]: 3,
};

/**
 * The single colour this layer reports for a future masthead chip tint
 * (Phase H, `LiveLayerCallbacks.reportColor`'s own doc comment): the most
 * severe colour among every weather warning's awareness colour and every
 * avalanche region's danger colour currently drawn. `null` when nothing
 * active carries one.
 */
function worstColorOf(colors: readonly string[]): string | null {
    let worst: string | null = null;
    let worstSeverity = -1;
    for (const color of colors) {
        const severity = COLOR_SEVERITY[color] ?? 0;
        if (severity > worstSeverity) {
            worst = color;
            worstSeverity = severity;
        }
    }
    return worst;
}

/** "14. sep. 06:00" -- a short date and a 24-hour clock, both through `Intl`, same helper `roads.ts` builds for itself. */
function formatMoment(iso: string): string {
    const date = new Date(iso);
    return `${formatShortDate(date)} ${formatTime(date)}`;
}

function buildWeatherPopup(warning: WeatherWarning): HTMLElement {
    const root = document.createElement('div');
    root.className = 'warning-popup';

    const heading = document.createElement('div');
    heading.className = 'warning-popup-heading';
    // MET's own `eventAwarenessName`, verbatim in both UI languages -- see
    // `WeatherWarningSchema`'s doc comment. Never run through `t()`.
    heading.textContent = warning.title;
    heading.style.setProperty(WARNING_COLOR_PROPERTY, colorForAwareness(warning.awarenessLevel));
    root.append(heading);

    // MET's own Norwegian advice text, verbatim -- the same reasoning
    // `roads.ts`'s `.road-popup-description` gets.
    const description = document.createElement('p');
    description.className = 'warning-popup-description';
    description.textContent = warning.description;
    root.append(description);

    if (warning.consequences !== null) {
        const consequences = document.createElement('p');
        consequences.className = 'warning-popup-consequences';
        consequences.textContent = warning.consequences;
        root.append(consequences);
    }

    if (warning.instruction !== null) {
        const instruction = document.createElement('p');
        instruction.className = 'warning-popup-instruction';
        instruction.textContent = warning.instruction;
        root.append(instruction);
    }

    if (warning.endsAt !== null) {
        const ends = document.createElement('div');
        ends.className = 'warning-popup-ends';
        ends.textContent = t('map.warningEndsAt', { when: formatMoment(warning.endsAt) });
        root.append(ends);
    }

    return root;
}

/**
 * NVE Varsom's own scale words for `dangerLevel` (1-5). A `switch` rather
 * than a `Record<number, ParamlessKey>` lookup -- the latter is a generic
 * index signature as far as `noUncheckedIndexedAccess` is concerned (`kind`
 * on `RoadSituation` is a closed literal union instead, which is why
 * `roads.ts`'s analogous `KIND_LABEL_KEYS[situation.kind]` needs no such
 * workaround), and `dangerLevel`'s own schema (`z.number().int().min(1).max(5)`)
 * is a plain `number`, not a literal union, so indexing would carry an
 * `| undefined` a schema-validated 1-5 integer never actually produces.
 */
function avalancheLevelLabel(level: number): string {
    switch (level) {
        case 1:
            return t('map.avalancheDanger.1');
        case 2:
            return t('map.avalancheDanger.2');
        case 3:
            return t('map.avalancheDanger.3');
        case 4:
            return t('map.avalancheDanger.4');
        default:
            return t('map.avalancheDanger.5');
    }
}

function buildAvalanchePopup(region: AvalancheWarning, now: Date = new Date()): HTMLElement {
    const root = document.createElement('div');
    root.className = 'avalanche-popup';

    // NVE's own region name, a place name rather than prose -- shown as-is
    // in both UI languages, same as a road situation's `location`.
    const heading = document.createElement('div');
    heading.className = 'avalanche-popup-heading';
    heading.textContent = region.regionName;
    root.append(heading);

    const level = document.createElement('div');
    level.className = 'avalanche-popup-level';
    level.style.setProperty(AVALANCHE_COLOR_PROPERTY, colorForDangerLevel(region.dangerLevel));
    // "3 · Betydelig" -- the digit NVE's own site leads with, and the
    // scale's own word beside it, same "code · word" arrangement
    // `roads.ts`'s `where` line uses for a road number beside a place.
    level.textContent = `${String(region.dangerLevel)} · ${avalancheLevelLabel(region.dangerLevel)}`;
    root.append(level);

    const updated = document.createElement('div');
    updated.className = 'avalanche-popup-updated';
    updated.textContent = t('map.popupUpdated', { age: formatAge(new Date(region.validAt), now) });
    root.append(updated);

    return root;
}

function buildAvalanchePinIcon(L: typeof Leaflet, region: AvalancheWarning): Leaflet.DivIcon {
    const plate = document.createElement('span');
    plate.className = 'avalanche-pin-plate';
    plate.style.setProperty(AVALANCHE_COLOR_PROPERTY, colorForDangerLevel(region.dangerLevel));

    const glyph = document.createElement('span');
    glyph.className = 'avalanche-pin-glyph';
    // A build-time constant (`glyphs/avalanche.svg`), never anything that
    // came off the wire.
    glyph.innerHTML = avalancheGlyph;
    glyph.setAttribute('aria-hidden', 'true');
    plate.append(glyph);

    // The digit is what a person reads across a room -- NVE's own 1-5
    // danger level, the same number Varsom's own site leads with.
    const level = document.createElement('span');
    level.className = 'avalanche-pin-level';
    level.textContent = String(region.dangerLevel);
    plate.append(level);

    return L.divIcon({
        className: 'avalanche-pin',
        html: plate,
        iconSize: [AVALANCHE_PIN_PX, AVALANCHE_PIN_PX],
        iconAnchor: [AVALANCHE_PIN_PX / 2, AVALANCHE_PIN_PX / 2],
    });
}

export function mountWarningsLayer(L: typeof Leaflet, map: Leaflet.Map, callbacks: LiveLayerCallbacks): () => void {
    return mountWhileEnabled(
        () => settings.get().warnings.enabled,
        () => {
            const renderer = sharedCanvasRenderer(L, map);
            const layerGroup = L.layerGroup().addTo(map);

            function clear(): void {
                layerGroup.clearLayers();
                callbacks.reportCount(0, 0);
                callbacks.reportItems([]);
                callbacks.reportAttribution(undefined);
                callbacks.reportColor?.(null);
            }

            function render(data: ConfiguredWarnings): void {
                // A wholesale rebuild (see this file's header comment) --
                // no id-based diffing at a 5-60 minute poll cadence.
                layerGroup.clearLayers();

                // Read inside the effect that calls `render`, so flipping
                // the checkbox re-filters what is already on screen
                // instead of waiting for the next poll -- the same
                // reasoning `transit.ts`'s `showBuses`/`showFerries` reads
                // get.
                const showAvalanche = settings.get().warnings.showAvalanche;

                // Each half defaults to `[]` independently: neither half's
                // `null` is ever examined while building the other, so a
                // MET outage cannot blank NVE's regions and vice versa
                // (`WarningsResponseSchema`'s own doc comment on why both
                // are nullable).
                const weatherWarnings = data.weatherWarnings ?? [];
                const avalancheWarnings = showAvalanche ? (data.avalancheWarnings ?? []) : [];

                const activeColors: string[] = [];
                const items: LiveLayerItem[] = [];

                for (const warning of weatherWarnings) {
                    const color = colorForAwareness(warning.awarenessLevel);
                    activeColors.push(color);

                    // The rare CAP alert with no polygon at all still
                    // counts and still shows in the panel list, but there
                    // is nothing here for this module to draw.
                    if (warning.polygon === null) continue;

                    let firstPoint: readonly [number, number] | undefined;
                    for (const ring of warning.polygon) {
                        // Filled at low opacity and stroked in the
                        // awareness colour -- one `L.polygon` per ring,
                        // not one polygon with holes: a CAP area can be a
                        // genuine multi-polygon (disjoint parts), the same
                        // "array of parts, each its own path" shape
                        // `roads.ts`'s `situation.line` uses.
                        const polygon = L.polygon(ring, {
                            renderer,
                            color,
                            weight: 2,
                            fillColor: color,
                            fillOpacity: 0.15,
                        });
                        polygon.bindPopup(() => buildWeatherPopup(warning), { className: 'warning-popup-wrapper', autoPanPadding: [20, 20] });
                        polygon.addTo(layerGroup);
                        firstPoint ??= ring[0];
                    }

                    if (firstPoint) {
                        items.push({
                            id: warning.id,
                            label: warning.title,
                            detail: warning.area ?? warning.event,
                            lat: firstPoint[0],
                            lng: firstPoint[1],
                        });
                    }
                }

                for (const region of avalancheWarnings) {
                    const color = colorForDangerLevel(region.dangerLevel);
                    // Level 1 is "no tint" by design (the European
                    // avalanche scale's own lowest tier) -- it draws a
                    // neutral outline and pin, but never competes for
                    // "worst active colour": nothing about it needs
                    // flagging.
                    if (region.dangerLevel > 1) activeColors.push(color);

                    // Outline only, no fill -- so it never visually fights
                    // a MET Alerts polygon covering the same ground.
                    // Non-interactive: the pin below is this region's tap
                    // target, the same split `roads.ts`'s casing/core
                    // lines make between scenery and the tappable core.
                    const outline = L.polygon(region.outline, {
                        renderer,
                        color,
                        weight: 2,
                        fill: false,
                        interactive: false,
                    });
                    outline.addTo(layerGroup);

                    const marker = L.marker([region.point.lat, region.point.lng], { icon: buildAvalanchePinIcon(L, region) });
                    marker.bindPopup(() => buildAvalanchePopup(region), { className: 'avalanche-popup-wrapper', autoPanPadding: [20, 20] });
                    marker.addTo(layerGroup);

                    items.push({
                        id: region.regionId,
                        label: region.regionName,
                        detail: avalancheLevelLabel(region.dangerLevel),
                        lat: region.point.lat,
                        lng: region.point.lng,
                    });
                }

                // Combined, not per-kind: the masthead shows this layer as
                // one group behind one toggle (unlike `roads.ts`'s two
                // groups), and the count follows what is actually drawn
                // (`showAvalanche`'s own reasoning above), mirroring
                // `transit.ts`'s convention rather than `roads.ts`'s
                // "always count current" exception -- that one exists only
                // because `showPlanned` filters on time, not on kind.
                //
                // No age filter on this layer -- a warning is valid until
                // it expires, not until it goes stale (`WARNINGS_LAYER`'s
                // own doc comment) -- so hidden-by-age is always 0.
                callbacks.reportCount(weatherWarnings.length + avalancheWarnings.length, 0);
                callbacks.reportItems(items);
                callbacks.reportAttribution(WARNINGS_LAYER.attribution);
                callbacks.reportColor?.(worstColorOf(activeColors));
            }

            const pollSeconds = Math.max(settings.get().warnings.pollSeconds, WARNINGS_LAYER.minPollSeconds);
            const res = resource(() => fetchWarnings(map), { intervalMs: pollSeconds * 1000 });

            const disposeEffect = effect(() => {
                const state = res.state.get();
                if (state.status !== 'ready') return;
                if (!state.data.configured) {
                    clear();
                    return;
                }
                render(state.data);
            });

            const disposeMoveRefetch = refetchOnMapMove(map, () => {
                res.refresh();
            });

            return function dispose(): void {
                disposeEffect();
                disposeMoveRefetch();
                res.dispose();
                layerGroup.clearLayers();
                map.removeLayer(layerGroup);
                callbacks.reportCount(0, 0);
                callbacks.reportItems([]);
                callbacks.reportAttribution(undefined);
                callbacks.reportColor?.(null);
            };
        },
    );
}
