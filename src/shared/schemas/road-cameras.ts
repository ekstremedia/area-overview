import { z } from 'zod';
import { IsoTimestampSchema } from './common.js';

/**
 * One of Statens vegvesen's road cameras. A *road camera* is never
 * called a camera in this app: `Camera`/`/api/cameras` is Terje's own
 * roster, a different feature with a different lifecycle.
 *
 * The unit here is the individual camera, not the site: up to four sit
 * at one location pointing different ways (`CAMERA_ID` is
 * `<siteId>_<n>`), and they share their coordinates exactly. The map
 * relies on that -- the generic marker clustering groups them with no
 * site-specific code at all, so a cluster *is* a site.
 */
export const RoadCameraSchema = z.object({
    /** Upstream's `CAMERA_ID` (`3000957_1`). Unique per orientation, and the diffing key across polls. */
    id: z.string(),
    /** The site this camera belongs to -- the `<siteId>` half of `id`, and the join key for `weatherBySite`. */
    siteId: z.string(),
    /** The site's name ("Hadselbrua"), the same for every camera at it. */
    name: z.string(),
    /** Which way this one points ("mot Stokmarknes"), when upstream says. Null is common and simply means the site name stands alone. */
    direction: z.string().nullable(),
    roadNumber: z.string().nullable(),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    /**
     * The still image, fetched **by the visitor's browser** -- the BFF
     * never proxies image bytes, the same arrangement the basemap tiles
     * and the aurora oval already have. Validated as a URL here, and its
     * host is asserted server-side, so a change upstream cannot quietly
     * make this app hotlink somewhere else.
     *
     * There is no separate thumbnail: every image is the full 800x600
     * JPEG, which is why a grid of them loads lazily. There is no
     * capture time either -- upstream publishes roughly once a minute,
     * and the picture is refreshed by re-setting `src`, never aged.
     */
    imageUrl: z.url(),
});

export type RoadCamera = z.infer<typeof RoadCameraSchema>;

/**
 * Road-weather readings for a camera site. Roughly two thirds of
 * Vegvesen's weather stations are co-located with a camera, which is the
 * whole reason this rides along with the camera list: it turns a picture
 * of a bridge into "and the road surface is at -1".
 *
 * Every reading is nullable and nulls are the norm, not an error case
 * (wind is missing on about 200 of 464 stations, road surface
 * temperature on 46). A null reading is omitted from the display rather
 * than shown as a dash, so anything present here is real.
 */
export const RoadCameraSiteWeatherSchema = z.object({
    /** When the station measured -- roughly every 10 minutes. Never null; a station with no timestamp is not carried at all. */
    measuredAt: IsoTimestampSchema,
    /** Air temperature, degrees Celsius. */
    airTemperature: z.number().nullable(),
    /** Road surface temperature, degrees Celsius -- the reading this display exists for in winter. */
    roadTemperature: z.number().nullable(),
    /** Mean wind speed in m/s (Datex II's unit; not documented on the WFS itself). The server refuses anything above 60 m/s -- past every wind speed ever recorded on the Norwegian mainland -- rather than pass on a reading it does not believe. */
    windSpeed: z.number().nullable(),
    /**
     * Gust in m/s, and the reading the server is strictest about.
     *
     * The 60 m/s ceiling applies here too, but on its own it was not
     * enough: a station was observed reporting a 54.4 m/s gust against
     * its own 14.8 m/s mean on a calm 9 °C evening -- a gust factor of
     * 3.7, where real weather produces 1.3-1.6. So where a mean is
     * present to compare against, a gust far above it is treated as a
     * sensor artifact and arrives here as null, while the mean beside it
     * is served as measured. See `MAX_PLAUSIBLE_GUST_RATIO` in
     * `src/server/roads/road-cameras.ts`.
     */
    windGust: z.number().nullable(),
    /** Precipitation intensity, mm/h. */
    precipitationIntensity: z.number().nullable(),
});

export type RoadCameraSiteWeather = z.infer<typeof RoadCameraSiteWeatherSchema>;

/**
 * `GET /api/road-cameras`. Unlike ships, aircraft and road situations,
 * this is NOT a `{configured:...}` discriminated union: the upstream is
 * keyless and this layer has no unconfigured state to report. The roads
 * layer's on/off toggle lives on `/api/road-situations`' envelope, which
 * does carry one.
 *
 * Keyed by site rather than nested inside each camera because a site's
 * four cameras would otherwise repeat the same readings four times, and
 * because a weather station with no camera in the viewport has nowhere
 * to hang -- it is simply absent from this map, which is correct.
 */
export const RoadCamerasResponseSchema = z.object({
    cameras: z.array(RoadCameraSchema),
    /** Site id -> readings, for those sites that have a co-located station with a recent measurement. Most sites are missing from this map entirely. */
    weatherBySite: z.record(z.string(), RoadCameraSiteWeatherSchema),
    fetchedAt: IsoTimestampSchema,
});

export type RoadCamerasResponse = z.infer<typeof RoadCamerasResponseSchema>;
