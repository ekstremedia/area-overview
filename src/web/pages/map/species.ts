/**
 * The Species (GBIF) live layer: polls `GET /api/species?bbox=&days=` for
 * the map's current viewport and draws one pin per grouped occurrence
 * sighting. Mounted only through `layers.ts`'s `mountLiveLayers`.
 *
 * Like `warnings.ts` and unlike `transit.ts`/`roads.ts`, this layer does
 * **not** diff by id across polls: it rebuilds its whole `L.layerGroup`
 * from scratch on every poll. `SPECIES_LAYER.minPollSeconds` is 1800s and
 * the default is 3600s -- even slower than warnings' 300-600s -- so the
 * `Map<id, entry>`/`setLatLng`/`setIcon` machinery `transit.ts` earns back
 * on a 15-120s cadence buys nothing here, and the one visible cost (an
 * open popup closing every poll) is rarer still at this cadence.
 *
 * `settings.species.animalsOnly` is a client-side filter, read live inside
 * the render effect (same reasoning as `transit.ts`'s
 * `showBuses`/`showFerries`): flipping it re-filters what is already on
 * screen instantly, with no extra request, and the masthead count follows
 * what is actually drawn -- `reportCount`'s argument is the post-filter
 * length, not GBIF's own group count.
 *
 * This layer is deliberately honest about being slow data: GBIF's own
 * `eventDate` already lags real life by weeks (`SightingSchema`'s own doc
 * comment), so there is no `maxAgeMinutes` here at all (`SPECIES_LAYER`'s
 * doc comment in `shared/layers.ts`) -- `settings.species.days` bounds the
 * *upstream query window*, not a staleness filter over the response, and
 * every popup carries the sighting's own `observedAt` date rather than
 * pretending to be a live position fix.
 */
import type * as Leaflet from 'leaflet';
import { SPECIES_LAYER } from '../../../shared/layers.js';
import { SpeciesResponseSchema, type Sighting, type SpeciesResponse } from '../../../shared/schemas/species.js';
import { err, ok, type Result } from '../../../shared/result.js';
import { resource } from '../../core/resource.js';
import { effect } from '../../core/signal.js';
import { formatNumber, locale, t } from '../../i18n/index.js';
import { settings } from '../../settings-resource.js';
import type { LiveLayerItem } from '../../shell/page-status.js';
import { SPECIES_PIN_COLOR } from './liveLayerColors.js';
import { mapToBboxQuery, mountWhileEnabled, refetchOnMapMove, type LiveLayerCallbacks } from './liveLayerMount.js';
/*
 * Original artwork for this project, not vendored -- see
 * `glyphs/README.md`, same convention `transit.ts`'s/`warnings.ts`'s own
 * glyphs follow.
 */
import birdGlyph from './glyphs/bird.svg?raw';
import fishGlyph from './glyphs/fish.svg?raw';
import insectGlyph from './glyphs/insect.svg?raw';
import mammalGlyph from './glyphs/mammal.svg?raw';
import organismGlyph from './glyphs/organism.svg?raw';
import plantGlyph from './glyphs/plant.svg?raw';

/** The full 44px tap-target minimum, same arrangement as this app's other pins. */
const SPECIES_PIN_PX = 44;

/** The CSS custom property `map.css`'s species pin rules read the plate colour from. */
const SPECIES_COLOR_PROPERTY = '--species-pin-color';

type ConfiguredSpecies = Extract<SpeciesResponse, { configured: true }>;

/**
 * GBIF's taxonomic `class`, mapped to this layer's own per-class glyph.
 * `SightingSchema` keeps `class` a passthrough string rather than a closed
 * enum specifically so a value this map does not (yet) draw a dedicated
 * glyph for still renders -- `glyphForClass`'s fallback below, exercised
 * by `species.test.ts`.
 *
 * `Magnoliopsida` (flowering plants) and `Pinopsida` (conifers) share one
 * glyph: at pin size the distinction between the two is not one a person
 * reading the map needs, only "this was a plant".
 */
const CLASS_GLYPHS: Readonly<Record<string, string>> = {
    Aves: birdGlyph,
    Mammalia: mammalGlyph,
    Actinopterygii: fishGlyph,
    Insecta: insectGlyph,
    Magnoliopsida: plantGlyph,
    Pinopsida: plantGlyph,
};

/** The documented fallback for a `class` value not in `CLASS_GLYPHS` -- an absent, empty, or simply unfamiliar one (GBIF's `class` is optional upstream and this app has not catalogued every value it can send). */
function glyphForClass(kingdomClass: string): string {
    return CLASS_GLYPHS[kingdomClass] ?? organismGlyph;
}

/**
 * A short, readable licence label extracted from GBIF's own Creative
 * Commons legalcode URL (e.g.
 * `"http://creativecommons.org/licenses/by-nc/4.0/legalcode"` ->
 * `"CC BY-NC 4.0"`), rather than showing the raw URL in a popup -- a
 * legalcode link is not friendly UI text, and every record this app has
 * seen in practice carries one of the handful of shapes handled below.
 * Falls back to the URL itself (still informative, if not pretty) for a
 * shape not recognised, or one that fails to parse as a URL at all --
 * `sighting.license` is a plain passthrough string, not validated as a URL
 * by the schema, so a malformed value must not throw.
 */
function speciesLicenseLabel(license: string): string {
    try {
        const url = new URL(license);
        const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
        const kindSegment = segments[1];
        if (segments[0] === 'licenses' && kindSegment !== undefined) {
            const kind = kindSegment.toUpperCase();
            const version = segments[2];
            return version === undefined ? `CC ${kind}` : `CC ${kind} ${version}`;
        }
        if (segments[0] === 'publicdomain' && segments[1] === 'zero') {
            const version = segments[2];
            return version === undefined ? 'CC0' : `CC0 ${version}`;
        }
        if (segments[0] === 'publicdomain' && segments[1] === 'mark') {
            return 'Public Domain Mark';
        }
        return license;
    } catch {
        return license;
    }
}

/** "14. sep. 2026" -- unlike `formatShortDate` (used elsewhere for same-year forecasts), this carries the year: `settings.species.days` can reach 365, so a bare day-and-month is ambiguous for the oldest sightings a window this wide can return. */
function formatObservedDate(iso: string): string {
    return new Intl.DateTimeFormat(locale.get(), { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
}

async function fetchSpecies(map: Leaflet.Map): Promise<Result<SpeciesResponse>> {
    // No usable viewport (see `mapToBboxQuery`). An error, not an empty
    // answer, so `resource` keeps whatever is already drawn.
    const bbox = mapToBboxQuery(map);
    if (bbox === null) return err({ message: 'Skipped GET /api/species: the map has no measurable viewport yet' });
    // Read fresh on every poll, not captured once at mount -- a
    // `settings.species.days` change takes effect on the next poll, the
    // same way `transit.ts`'s `maxAgeMinutes` read does.
    const days = settings.get().species.days;
    try {
        const response = await fetch(`/api/species?bbox=${bbox}&days=${String(days)}`);
        // 503 carries the documented `{configured:false}` body, which is a
        // valid response rather than a failure -- see `roads.ts`/`warnings.ts`.
        if (!response.ok && response.status !== 503) {
            return err({ message: `GET /api/species responded ${String(response.status)}` });
        }
        const json: unknown = await response.json();
        const parsed = SpeciesResponseSchema.safeParse(json);
        if (!parsed.success) {
            return err({ message: 'GET /api/species returned a payload that failed schema validation', cause: parsed.error });
        }
        return ok(parsed.data);
    } catch (cause) {
        return err({ message: 'Network error fetching /api/species', cause });
    }
}

/**
 * The popup content, in the order the plan settled on: the Norwegian
 * (vernacular) name where GBIF gave one, otherwise the scientific name in
 * italics (never a blank line or the literal word "null" -- the point
 * `species.test.ts` exercises directly); the observation date; the record
 * count; the individual count when GBIF reported one; the source
 * dataset(s); the licence; and, only when present, the coordinate
 * uncertainty as an honest caveat.
 *
 * `count` and `individualCount` are shown as two separate lines rather
 * than merged into one sentence: they answer different questions (how many
 * raw GBIF records this pin folds together, vs. how many individual
 * animals/plants were reported across them), and a reader conflating "3
 * observations" with "3 individuals" would draw the wrong conclusion when
 * one record reports a flock of twelve.
 */
function buildSpeciesPopup(sighting: Sighting): HTMLElement {
    const root = document.createElement('div');
    root.className = 'species-popup';

    const heading = document.createElement('div');
    heading.className = 'species-popup-heading';
    if (sighting.vernacularName !== null) {
        heading.textContent = sighting.vernacularName;
    } else {
        const scientificName = document.createElement('i');
        scientificName.className = 'species-popup-scientific-name';
        scientificName.textContent = sighting.scientificName;
        heading.append(scientificName);
    }
    root.append(heading);

    const date = document.createElement('div');
    date.className = 'species-popup-date';
    date.textContent = t('map.speciesObservedOn', { when: formatObservedDate(sighting.observedAt) });
    root.append(date);

    const count = document.createElement('div');
    count.className = 'species-popup-count';
    count.textContent = t('map.speciesObservationCount', { count: formatNumber(sighting.count) });
    root.append(count);

    if (sighting.individualCount !== null) {
        const individuals = document.createElement('div');
        individuals.className = 'species-popup-individuals';
        individuals.textContent = t('map.speciesIndividualCount', { count: formatNumber(sighting.individualCount) });
        root.append(individuals);
    }

    const datasets = document.createElement('div');
    datasets.className = 'species-popup-datasets';
    datasets.textContent = t('map.speciesDatasets', { datasets: sighting.datasets.map((dataset) => dataset.title).join(', ') });
    root.append(datasets);

    const license = document.createElement('div');
    license.className = 'species-popup-license';
    license.textContent = t('map.speciesLicense', { license: speciesLicenseLabel(sighting.license) });
    root.append(license);

    if (sighting.coordinateUncertaintyMeters !== null) {
        const uncertainty = document.createElement('div');
        uncertainty.className = 'species-popup-uncertainty';
        uncertainty.textContent = t('map.speciesUncertainty', {
            meters: formatNumber(Math.round(sighting.coordinateUncertaintyMeters), t('unit.meters')),
        });
        root.append(uncertainty);
    }

    return root;
}

function buildSpeciesPinIcon(L: typeof Leaflet, sighting: Sighting): Leaflet.DivIcon {
    const plate = document.createElement('span');
    plate.className = 'species-pin-plate';
    plate.style.setProperty(SPECIES_COLOR_PROPERTY, SPECIES_PIN_COLOR);

    const glyph = document.createElement('span');
    glyph.className = 'species-pin-glyph';
    // A build-time constant (`glyphs/*.svg`), never anything that came off
    // the wire.
    glyph.innerHTML = glyphForClass(sighting.class);
    glyph.setAttribute('aria-hidden', 'true');
    plate.append(glyph);

    return L.divIcon({
        className: 'species-pin',
        html: plate,
        iconSize: [SPECIES_PIN_PX, SPECIES_PIN_PX],
        iconAnchor: [SPECIES_PIN_PX / 2, SPECIES_PIN_PX / 2],
    });
}

export function mountSpeciesLayer(L: typeof Leaflet, map: Leaflet.Map, callbacks: LiveLayerCallbacks): () => void {
    return mountWhileEnabled(
        () => settings.get().species.enabled,
        () => {
            const layerGroup = L.layerGroup().addTo(map);

            function clear(): void {
                layerGroup.clearLayers();
                callbacks.reportCount(0, 0);
                callbacks.reportItems([]);
                callbacks.reportAttribution(undefined);
            }

            function render(data: ConfiguredSpecies): void {
                // A wholesale rebuild (see this file's header comment) --
                // no id-based diffing at a 30-minute-to-6-hour poll cadence.
                layerGroup.clearLayers();

                // Read inside the effect that calls `render`, so flipping
                // the checkbox re-filters what is already on screen
                // instead of waiting for the next poll -- the same
                // reasoning `transit.ts`'s `showBuses`/`showFerries` reads
                // get.
                const animalsOnly = settings.get().species.animalsOnly;
                const visible = animalsOnly ? data.sightings.filter((sighting) => sighting.kingdom === 'Animalia') : data.sightings;

                const items: LiveLayerItem[] = [];
                for (const sighting of visible) {
                    const marker = L.marker([sighting.point.lat, sighting.point.lng], { icon: buildSpeciesPinIcon(L, sighting) });
                    marker.bindPopup(() => buildSpeciesPopup(sighting), { className: 'species-popup-wrapper', autoPanPadding: [20, 20] });
                    marker.addTo(layerGroup);

                    items.push({
                        id: sighting.id,
                        label: sighting.vernacularName ?? sighting.scientificName,
                        detail: formatObservedDate(sighting.observedAt),
                        lat: sighting.point.lat,
                        lng: sighting.point.lng,
                    });
                }

                // The count follows what is actually drawn -- post
                // `animalsOnly`-filter -- mirroring `transit.ts`'s
                // convention. Always `0` hidden-by-age: this layer has no
                // age filter at all (see this file's header comment).
                callbacks.reportCount(visible.length, 0);
                callbacks.reportItems(items);

                // Truncation honesty: when GBIF's own count exceeded the
                // server's cap, say so in the footer rather than silently
                // showing part of the data (the plan's own requirement) --
                // the simplest correct place for that caveat is the one
                // line this layer already contributes to the shared
                // attribution string, appended rather than surfaced through
                // a new UI mechanism no other layer has.
                callbacks.reportAttribution(
                    data.truncated ? `${SPECIES_LAYER.attribution} (${t('map.speciesTruncatedSuffix')})` : SPECIES_LAYER.attribution,
                );
            }

            const pollSeconds = Math.max(settings.get().species.pollSeconds, SPECIES_LAYER.minPollSeconds);
            const res = resource(() => fetchSpecies(map), { intervalMs: pollSeconds * 1000 });

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
            };
        },
    );
}
