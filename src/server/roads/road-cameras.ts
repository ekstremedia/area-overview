/**
 * Statens vegvesen's road cameras, with the road-weather readings from
 * the stations sitting at the same places.
 *
 * A *road camera* is never called a camera in this app: `/api/cameras`
 * is Terje's own roster, a different feature with a different lifecycle.
 *
 * Two WFS layers make one response. `CctvSimple_v2` is the cameras (890
 * nationwide, up to four orientations per site, `CAMERA_ID` being
 * `<siteId>_<n>`); `WeatherSimple_v2` is the stations (464, of which 308
 * carry a `REFERENCE_ID` equal to a camera's site id -- they are
 * physically co-located). Joining them is what turns a picture of a
 * bridge into "and the road surface is at -1".
 *
 * The weather half is an enrichment and is treated as one: if it fails,
 * is refused by the shared outbound gate, or simply has nothing for a
 * site, the cameras are still served. The reverse is not true -- a
 * station with no camera in the viewport has nothing to hang on and is
 * dropped.
 *
 * `imageUrl`'s host is asserted here, server-side. The still is fetched
 * by the visitor's browser (the BFF never proxies image bytes, exactly
 * as with the basemap tiles and the aurora oval), so this assertion is
 * what stops a change upstream from quietly making every visitor's
 * browser fetch from somewhere else.
 */
import { z } from 'zod';
import { IsoTimestampSchema } from '../../shared/schemas/common.js';
import { RoadCameraSchema, RoadCameraSiteWeatherSchema, type RoadCamera, type RoadCameraSiteWeather } from '../../shared/schemas/road-cameras.js';
import { ok, type Result } from '../../shared/result.js';
import type { Bbox } from '../layers/bbox.js';
import type { OutboundGate } from '../outbound-gate.js';
import { DiscardTally, type DiscardSummary } from './discards.js';
import { CCTV_TYPE_NAME, fetchFeatures, WEATHER_TYPE_NAME, type RawFeature } from './vegvesen-wfs.js';

/** The only host a road camera still may be fetched from. Every probed `STILL_IMAGE_URL` was `https://kamera.atlas.vegvesen.no/api/images/<CAMERA_ID>`; anything else is not served to a browser. */
export const ROAD_CAMERA_IMAGE_HOST = 'kamera.atlas.vegvesen.no';

/**
 * Above this, a wind reading is not believed at all -- the absolute
 * backstop, applied to the mean and the gust alike.
 *
 * The WFS does not document its wind unit; Datex II says m/s and the
 * medians (2.5 and 4.4) agree. 60 m/s is past every wind speed ever
 * recorded on the Norwegian mainland, so a reading beyond it is a broken
 * sensor rather than weather, and nothing real is discarded by refusing
 * it. A refused reading is omitted from the display, never shown as a
 * dash or a zero.
 */
export const MAX_PLAUSIBLE_WIND_MPS = 60;

/**
 * How far above the mean wind speed a gust may claim to be before it is
 * treated as a sensor artifact rather than a gust.
 *
 * The absolute cap alone is not enough, and that is measured, not
 * supposed: station 1800428 reported a 54.4 m/s gust (196 km/h) against
 * a 14.8 m/s mean at 20:30 on a 9 °C September evening -- a gust factor
 * of 3.7. Real gust factors over open terrain sit around 1.3-1.6, and
 * even a violent squall does not reach 3x the ten-minute mean. That
 * reading sailed straight under a 60 m/s cutoff and onto the wall
 * display as a hurricane.
 *
 * So when there is a mean to compare against, the gust is checked
 * against it. 1.8 leaves real gustiness a wide margin above the 1.6 a
 * rough site actually produces, while catching the artifacts, which miss
 * by a factor of two rather than by a few per cent. This app would
 * rather show one honest number than two where one is a lie.
 */
export const MAX_PLAUSIBLE_GUST_RATIO = 1.8;

/**
 * The mean wind speed below which the ratio test is not applied.
 *
 * Two reasons, and neither is the division by zero (though that is real
 * too, and a calm station reporting exactly 0 is common). First, a
 * genuine gust factor *is* large in light air: 4 m/s off a fjord against
 * a 1 m/s mean is an ordinary afternoon, not a fault, and a ratio test
 * there would throw away good data on every calm day. Second, a mean
 * this small is at the resolution limit of the instrument, so the ratio
 * it produces says more about rounding than about the wind. Below the
 * floor, only the absolute cap applies -- and at these speeds a gust
 * that is wrong is not a gust anyone would act on anyway.
 */
const MIN_MEAN_FOR_GUST_RATIO_MPS = 2;

const NumericSchema = z.union([z.number(), z.string()]).nullish();

type Numeric = z.infer<typeof NumericSchema>;

function asNumber(value: Numeric): number | null {
    if (value === null || value === undefined) return null;
    const parsed = typeof value === 'number' ? value : Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
}

function text(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === '' ? null : trimmed;
}

const IdSchema = z.union([z.string(), z.number()]).transform((value) => String(value));

const RawCameraPropsSchema = z.object({
    CAMERA_ID: IdSchema,
    /** The site's name ("Hadselbrua"), repeated on each of its cameras. */
    DESCRIPTION: z.string().nullish(),
    ORIENTATION_DESCRIPTION: z.string().nullish(),
    ROAD_NUMBER: z.string().nullish(),
    STATUS_STILL_IMAGE_AVAILABILITY: z.string().nullish(),
    STILL_IMAGE_URL: z.string().nullish(),
});

/**
 * A station's readings. Every name is confirmed against
 * `DescribeFeatureType` on `datex_3_1:WeatherSimple_v2` (2026-09-13);
 * the gust is `MAXIMUM_WIND_SPEED`, and there is no `MAX_WIND_SPEED` on
 * the layer at all.
 *
 * `DEPTH_OF_SNOW` exists but is deliberately not read: null on 399 of
 * 464 stations, which is not a measurement, it is a field. So are
 * `WIND_DIRECTION_COMPASS` and `PRECIPITATION_TYPE`, null on every
 * station probed.
 */
const RawWeatherPropsSchema = z.object({
    REFERENCE_ID: IdSchema.nullish(),
    MEASUREMENT_TIME: IsoTimestampSchema.nullish(),
    AIR_TEMPERATURE: NumericSchema,
    ROAD_SURFACE_TEMPERATURE: NumericSchema,
    WIND_SPEED: NumericSchema,
    MAXIMUM_WIND_SPEED: NumericSchema,
    PRECIPITATION_INTENSITY: NumericSchema,
});

/** `<siteId>_<n>` -- the site is everything before the last underscore. A camera id with no underscore is its own site, which is the honest reading of an upstream that stopped following its own convention. */
export function siteIdOf(cameraId: string): string {
    const separator = cameraId.lastIndexOf('_');
    return separator <= 0 ? cameraId : cameraId.slice(0, separator);
}

/**
 * `true` when upstream says this camera's picture is not available --
 * 52 of 890 were, all spelled
 * `videoOrImagesUnavailableDueToCameraFault`. A faulted camera is
 * dropped entirely rather than pinned as a placeholder: a pin that opens
 * a broken image is worse than no pin.
 *
 * Matched on "unavailable" rather than the exact string, so a new
 * spelling of "broken" is still caught, while a status this app has
 * never seen is kept -- an unrecognised status is far more likely to be
 * a new way of saying "fine" than a fault, and erring the other way
 * would empty the layer on an upstream rename.
 */
function isFaulted(status: string | null | undefined): boolean {
    return (status ?? '').toLowerCase().includes('unavailable');
}

/** The still image URL, or `null` when it is missing, unparseable, not `https`, or not on `ROAD_CAMERA_IMAGE_HOST`. */
function safeImageUrl(raw: string | null | undefined): string | null {
    const value = text(raw);
    if (value === null) return null;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:') return null;
    if (url.hostname.toLowerCase() !== ROAD_CAMERA_IMAGE_HOST) return null;
    return url.toString();
}

/** Road cameras carry their position as a GeoJSON `Point`; `[lng, lat]` there, `lat`/`lng` fields here. */
function positionOf(feature: RawFeature): { lat: number; lng: number } | null {
    const geometry = feature.geometry;
    if (geometry?.type !== 'Point') return null;
    return { lat: geometry.coordinates[1], lng: geometry.coordinates[0] };
}

/**
 * Maps the `CctvSimple_v2` features onto `RoadCamera`s, dropping faulted
 * cameras, cameras with no position, and cameras whose image is not on
 * Vegvesen's own host. Pure.
 *
 * Everything dropped for a reason that is *not* upstream's own fault
 * flag is counted into `discards`, which the route logs (see
 * `discards.ts`). The host check matters most: it is a security control,
 * so the day Vegvesen moves its stills off `kamera.atlas.vegvesen.no`
 * this layer empties, and it must say so rather than look like a
 * viewport with no cameras in it. A faulted camera is not counted -- 52
 * of 890 are faulted on an ordinary day, and a warning that fires every
 * time is a warning nobody reads.
 */
export function mapRoadCameras(features: readonly RawFeature[], discards: DiscardTally = new DiscardTally()): RoadCamera[] {
    const cameras: RoadCamera[] = [];
    for (const feature of features) {
        discards.seen();
        const parsed = RawCameraPropsSchema.safeParse(feature.properties ?? {});
        if (!parsed.success) {
            discards.discard('attributes');
            continue;
        }
        const props = parsed.data;

        if (isFaulted(props.STATUS_STILL_IMAGE_AVAILABILITY)) continue;

        const imageUrl = safeImageUrl(props.STILL_IMAGE_URL);
        if (imageUrl === null) {
            discards.discard('imageHost');
            continue;
        }

        const position = positionOf(feature);
        if (!position) {
            discards.discard('unplaceable');
            continue;
        }

        const candidate = {
            id: props.CAMERA_ID,
            siteId: siteIdOf(props.CAMERA_ID),
            name: text(props.DESCRIPTION) ?? props.CAMERA_ID,
            direction: text(props.ORIENTATION_DESCRIPTION),
            roadNumber: text(props.ROAD_NUMBER),
            lat: position.lat,
            lng: position.lng,
            imageUrl,
        };

        const validated = RoadCameraSchema.safeParse(candidate);
        if (validated.success) {
            cameras.push(validated.data);
        } else {
            discards.discard('contract');
        }
    }
    return cameras;
}

/** A wind reading, or `null` where there is none or where it is beyond `MAX_PLAUSIBLE_WIND_MPS`. */
function windReading(value: number | null): number | null {
    if (value === null) return null;
    return value > MAX_PLAUSIBLE_WIND_MPS ? null : value;
}

/**
 * A gust reading, judged against the mean it is supposed to be a gust
 * of.
 *
 * The absolute cap first, then the ratio -- and the ratio only when
 * there is a mean worth dividing by. Wind is null on roughly 200 of the
 * 464 stations, and a gust from a station that reports no mean is not
 * suspect for that reason alone, so it keeps the cap and nothing more.
 *
 * The mean is never dropped when its gust is: the two are separate
 * measurements, and the one this test finds implausible is the gust.
 */
function gustReading(gust: number | null, mean: number | null): number | null {
    const capped = windReading(gust);
    if (capped === null) return null;
    if (mean === null || mean < MIN_MEAN_FOR_GUST_RATIO_MPS) return capped;
    return capped > mean * MAX_PLAUSIBLE_GUST_RATIO ? null : capped;
}

/**
 * Maps the `WeatherSimple_v2` features onto readings keyed by the camera
 * site they belong to, keeping only the stations `siteIds` actually has
 * cameras for.
 *
 * A station with no `REFERENCE_ID`, or one whose reference matches no
 * camera in this viewport, is dropped: `weatherBySite` exists to
 * annotate a picture, and there is no picture to annotate. Where two
 * stations somehow claim the same site, the later measurement wins.
 *
 * Only the two drops that mean something went wrong are counted into
 * `discards`: an attribute bag that does not parse, and a reading the
 * shared schema refuses. Having no camera to hang on, and having no
 * measurement time, are ordinary -- both happen on a healthy Vesterålen
 * response -- and counting them would drown the signal. See
 * `discards.ts`.
 */
export function mapSiteWeather(
    features: readonly RawFeature[],
    siteIds: ReadonlySet<string>,
    discards: DiscardTally = new DiscardTally(),
): Record<string, RoadCameraSiteWeather> {
    const bySite: Record<string, RoadCameraSiteWeather> = {};

    for (const feature of features) {
        discards.seen();
        const parsed = RawWeatherPropsSchema.safeParse(feature.properties ?? {});
        if (!parsed.success) {
            discards.discard('attributes');
            continue;
        }
        const props = parsed.data;

        const siteId = props.REFERENCE_ID;
        if (siteId == null || !siteIds.has(siteId)) continue;
        // No timestamp, no reading: the shared schema requires one, and a
        // measurement of unknown age is not worth showing next to a live
        // picture.
        if (props.MEASUREMENT_TIME == null) continue;

        // The mean is judged on its own; the gust is judged against the
        // mean that survived, so a mean the cap refused cannot drag a
        // plausible gust down with it.
        const windSpeed = windReading(asNumber(props.WIND_SPEED));
        const candidate = {
            measuredAt: props.MEASUREMENT_TIME,
            airTemperature: asNumber(props.AIR_TEMPERATURE),
            roadTemperature: asNumber(props.ROAD_SURFACE_TEMPERATURE),
            windSpeed,
            windGust: gustReading(asNumber(props.MAXIMUM_WIND_SPEED), windSpeed),
            precipitationIntensity: asNumber(props.PRECIPITATION_INTENSITY),
        };

        const validated = RoadCameraSiteWeatherSchema.safeParse(candidate);
        if (!validated.success) {
            discards.discard('contract');
            continue;
        }

        const existing = bySite[siteId];
        if (existing && Date.parse(existing.measuredAt) >= Date.parse(validated.data.measuredAt)) continue;
        bySite[siteId] = validated.data;
    }

    return bySite;
}

export interface FetchRoadCamerasOptions {
    upstreamTimeoutMs: number;
    /** The shared Statens vegvesen gate. Both WFS calls go through it, so a camera refresh costs two tokens -- which is what it costs upstream. */
    gate?: OutboundGate | undefined;
    fetchImpl?: typeof fetch;
    /** Called when the weather half failed, so the route can log it without this module knowing what a logger is. */
    onWeatherFailure?: (message: string) => void;
    /** Called once, after both halves have been mapped, when either mapper refused a record -- same arrangement as `onWeatherFailure`: this module counts, the route logs. Not called at all on a clean fetch. */
    onDiscards?: (discards: RoadCameraDiscards) => void;
}

/** What the two mappers refused, kept apart because they count different things: `cameras` is out of the CCTV records, `weather` out of the station records. */
export interface RoadCameraDiscards {
    cameras: DiscardSummary;
    weather: DiscardSummary;
}

export interface RoadCamerasPayload {
    cameras: RoadCamera[];
    weatherBySite: Record<string, RoadCameraSiteWeather>;
}

/**
 * The cameras in `bbox` and the road weather for the sites among them.
 *
 * Sequential, not `Promise.all`: the two calls share one token bucket,
 * and issuing them together would let a burst spend tokens on weather
 * that the cameras themselves then go without. It also means a shut gate
 * costs the weather, not the pictures.
 */
export async function fetchRoadCameras(bbox: Bbox, options: FetchRoadCamerasOptions): Promise<Result<RoadCamerasPayload>> {
    const shared = {
        upstreamTimeoutMs: options.upstreamTimeoutMs,
        gate: options.gate,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    };

    const cameraDiscards = new DiscardTally();
    const weatherDiscards = new DiscardTally();
    /** One report per fetch, and only when there is something to report -- the cap warning's rule in `routes/road-situations.ts`. */
    const report = (): void => {
        if (cameraDiscards.dropped + weatherDiscards.dropped === 0) return;
        options.onDiscards?.({ cameras: cameraDiscards.summary(), weather: weatherDiscards.summary() });
    };

    const cameraFeatures = await fetchFeatures(CCTV_TYPE_NAME, bbox, shared);
    if (!cameraFeatures.ok) return cameraFeatures;

    const cameras = mapRoadCameras(cameraFeatures.value, cameraDiscards);
    const siteIds = new Set(cameras.map((camera) => camera.siteId));

    const weatherFeatures = await fetchFeatures(WEATHER_TYPE_NAME, bbox, shared);
    if (!weatherFeatures.ok) {
        // Deliberately not an error for the whole request: a road camera
        // without a temperature under it is still the thing the visitor
        // asked for.
        options.onWeatherFailure?.(weatherFeatures.error.message);
        report();
        return ok({ cameras, weatherBySite: {} });
    }

    const weatherBySite = mapSiteWeather(weatherFeatures.value, siteIds, weatherDiscards);
    report();
    return ok({ cameras, weatherBySite });
}
