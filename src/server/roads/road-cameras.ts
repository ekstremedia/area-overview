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
import { CCTV_TYPE_NAME, fetchFeatures, WEATHER_TYPE_NAME, type RawFeature } from './vegvesen-wfs.js';

/** The only host a road camera still may be fetched from. Every probed `STILL_IMAGE_URL` was `https://kamera.atlas.vegvesen.no/api/images/<CAMERA_ID>`; anything else is not served to a browser. */
export const ROAD_CAMERA_IMAGE_HOST = 'kamera.atlas.vegvesen.no';

/**
 * Above this, a wind reading is not believed.
 *
 * The WFS does not document its wind unit; Datex II says m/s and the
 * medians (2.5 and 4.4) agree, but one station was seen reporting 55 --
 * hurricane force, on a day that was not. Rather than guess which
 * sensor lies, anything beyond what a Norwegian road station could
 * plausibly measure is treated as missing, and a missing reading is
 * simply omitted from the display. 60 m/s is past every wind speed ever
 * recorded on the Norwegian mainland, so nothing real is discarded.
 */
export const MAX_PLAUSIBLE_WIND_MPS = 60;

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

/** Maps the `CctvSimple_v2` features onto `RoadCamera`s, dropping faulted cameras, cameras with no position, and cameras whose image is not on Vegvesen's own host. Pure. */
export function mapRoadCameras(features: readonly RawFeature[]): RoadCamera[] {
    const cameras: RoadCamera[] = [];
    for (const feature of features) {
        const parsed = RawCameraPropsSchema.safeParse(feature.properties ?? {});
        if (!parsed.success) continue;
        const props = parsed.data;

        if (isFaulted(props.STATUS_STILL_IMAGE_AVAILABILITY)) continue;

        const imageUrl = safeImageUrl(props.STILL_IMAGE_URL);
        if (imageUrl === null) continue;

        const position = positionOf(feature);
        if (!position) continue;

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
        if (validated.success) cameras.push(validated.data);
    }
    return cameras;
}

/** A wind reading, or `null` where there is none or where it is beyond `MAX_PLAUSIBLE_WIND_MPS`. */
function windReading(value: number | null): number | null {
    if (value === null) return null;
    return value > MAX_PLAUSIBLE_WIND_MPS ? null : value;
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
 */
export function mapSiteWeather(features: readonly RawFeature[], siteIds: ReadonlySet<string>): Record<string, RoadCameraSiteWeather> {
    const bySite: Record<string, RoadCameraSiteWeather> = {};

    for (const feature of features) {
        const parsed = RawWeatherPropsSchema.safeParse(feature.properties ?? {});
        if (!parsed.success) continue;
        const props = parsed.data;

        const siteId = props.REFERENCE_ID;
        if (siteId == null || !siteIds.has(siteId)) continue;
        // No timestamp, no reading: the shared schema requires one, and a
        // measurement of unknown age is not worth showing next to a live
        // picture.
        if (props.MEASUREMENT_TIME == null) continue;

        const candidate = {
            measuredAt: props.MEASUREMENT_TIME,
            airTemperature: asNumber(props.AIR_TEMPERATURE),
            roadTemperature: asNumber(props.ROAD_SURFACE_TEMPERATURE),
            windSpeed: windReading(asNumber(props.WIND_SPEED)),
            windGust: windReading(asNumber(props.MAXIMUM_WIND_SPEED)),
            precipitationIntensity: asNumber(props.PRECIPITATION_INTENSITY),
        };

        const validated = RoadCameraSiteWeatherSchema.safeParse(candidate);
        if (!validated.success) continue;

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

    const cameraFeatures = await fetchFeatures(CCTV_TYPE_NAME, bbox, shared);
    if (!cameraFeatures.ok) return cameraFeatures;

    const cameras = mapRoadCameras(cameraFeatures.value);
    const siteIds = new Set(cameras.map((camera) => camera.siteId));

    const weatherFeatures = await fetchFeatures(WEATHER_TYPE_NAME, bbox, shared);
    if (!weatherFeatures.ok) {
        // Deliberately not an error for the whole request: a road camera
        // without a temperature under it is still the thing the visitor
        // asked for.
        options.onWeatherFailure?.(weatherFeatures.error.message);
        return ok({ cameras, weatherBySite: {} });
    }

    return ok({ cameras, weatherBySite: mapSiteWeather(weatherFeatures.value, siteIds) });
}
