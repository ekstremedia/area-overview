# Architecture

How the pieces fit together, with all twelve roadmap phases landed.
`docs/ROADMAP.md` has the phase plan and `docs/adr/` the reasoning behind the
larger decisions.

## Overview

area-overview is a reactive vanilla-TypeScript frontend (no framework) paired
with a small Node/TypeScript backend-for-frontend (BFF) on Fastify. The BFF
proxies and shapes data from the one upstream -- the Laravel API at
`nesthus.no`, which serves weather, tide, aurora and Terje's own cameras --
and calls three providers directly for the live data upstream has nothing for:
BarentsWatch (AIS ships), an ADS-B aggregator (aircraft) and Statens vegvesen
(road situations and road cameras). It keeps every credential off the client,
validates every payload with Zod, and caches what it fetches.

In production the BFF also serves the frontend: `src/server/static.ts`
registers `@fastify/static` over `dist/web` with an SPA fallback to
`index.html` for any non-`/api` path, but only when that build exists on disk,
so `npm run dev` leaves the frontend to Vite's own dev server.

## BFF

### Entry and composition

`src/server/index.ts` loads config, builds the app and listens on
`config.port`/`config.host` -- `8141` and `127.0.0.1` by default, and `0.0.0.0`
is never hardcoded or defaulted here.

`src/server/app.ts`'s `buildApp` assembles a configured Fastify instance
without starting it, so tests drive routes through `app.inject()` with no port
and no network. Registration order matters in one place: settings is
registered before weather because `registerSettingsRoutes` returns the
`SettingsStore` the weather route's Netatmo gate reads on every request, and
there must be exactly one store -- it owns the file and its write queue.
`buildApp` also builds what two consumers share: the BarentsWatch token and
the one nationwide AIS snapshot, the ADS-B outbound gate, and a single Statens
vegvesen gate for both road routes. The trail poller starts from an `onReady`
hook and stops from `onClose`, never during `buildApp`, so an injecting test
makes no outbound calls.

`src/server/config.ts` parses `process.env` through a Zod schema and throws at
boot rather than defaulting around a deployment mistake. Exactly one variable
is required -- `SETTINGS_PASSWORD`, as `z.string().min(16)`, so a missing value
and a too-short one fail the same loud way. Everything else defaults: port and
host, upstream base URL and timeout, a cache TTL per route family, the
outbound gates' intervals and bursts, the trail poller's area and cadence.
Provider credentials are all optional and running without them is expected --
with no BarentsWatch pair `GET /api/ships` answers `{configured:false}` rather
than refusing to boot, the default ADS-B aggregator and Statens vegvesen are
keyless, and an empty `CARTO_API_KEY` yields watermarked tiles, not none.

### Routes

Under `src/server/routes/`:

- `healthz.ts` -- `GET /healthz`. Touches no cache and validates nothing: a
  `HEAD` at upstream's root under its own short timeout, plus the version.
- `map-config.ts` -- `GET /api/map-config`. Runtime config the Docker build
  cannot bake in; today just the client-visible `cartoApiKey` (ADR 0003).
- `settings.ts` -- `GET`/`PATCH /api/settings`, `POST /api/settings/login`,
  `PUT`/`DELETE /api/settings/placements/:cameraId`. Local store, no upstream,
  and no `ETag`: the read sends `Cache-Control: no-store`.
- `weather.ts` -- `GET /api/weather` and `/api/weather/summary`, from
  upstream; `?lat&lng` forwarded (spelled `lng`, never `lon`).
- `aurora.ts` -- `GET /api/aurora`: upstream's `/api/aurora/all` with the
  probability at the requested position attached from NOAA's OVATION model.
- `tide.ts` -- `GET /api/tide`, upstream's tide at `timespan=24h`; with
  `?lat&lng` upstream picks the nearest Kartverket station itself.
- `cameras.ts` -- `GET /api/cameras`, upstream's camera roster passed through
  as its own envelope. Dormant in the UI; the route stays live.
- `ships.ts` -- `GET /api/ships?bbox=`, BarentsWatch via the shared nationwide
  snapshot. The only route with an unconfigured state
  (`503 {configured:false}`), distinguishable from a genuine zero.
- `aircraft.ts` -- `GET /api/aircraft?bbox=`, the ADS-B provider. Always
  `{configured:true}` on success, since no aggregator needs a key.
- `road-situations.ts` -- `GET /api/road-situations?bbox=`, Statens vegvesen.
  The cache holds raw records; current/scheduled/planned is derived from the
  clock per response, never cached.
- `road-cameras.ts` -- `GET /api/road-cameras?bbox=`, same provider on a
  longer TTL: the roster barely changes, and a camera-side outage must not
  blank the road notices.

### Shared plumbing

`upstream.ts` is the single choke point to `nesthus.no`: every route calls
`fetchUpstream(path, schema, config)` instead of `fetch`, so the timeout,
non-2xx, an empty `204`, a non-JSON body and a schema failure are handled in
one place and all come back as a `Result`. It takes no host or URL parameter,
so a caller cannot smuggle an arbitrary origin through it.

`cache.ts`'s `TtlCache` is a `Map`-backed TTL cache with two behaviours the
routes lean on: an expired entry is not deleted, so it can still be read
(tagged `stale: true`) as a fallback, and `getOrLoad` single-flights
concurrent loads of one key into one upstream call. An optional `maxEntries`
adds an LRU cap wherever the key space is public input.

`route-helpers.ts` ties those together. `serveCached` loads through the cache,
hashes the body it is about to send into an `ETag`, answers `304` on a
matching `If-None-Match`, falls back to a stale entry tagged `X-Cache: stale`
when a load fails, and `502` when there is nothing left. `cacheSeconds(ttlMs)`
derives `Cache-Control: max-age` from the route's own TTL, rounded down and
never below 1, so a response is never advertised as fresher than this server
considers it. The `transform` hook is applied to the cached document per
response, fresh and stale alike: it is how one cache entry serves an
authorised and an unauthorised `/api/weather` (Netatmo stripped or not), how
`/api/aurora` attaches one visitor's probability, and how
`/api/road-situations` keeps clock-dependent status out of the cache.

`outbound-gate.ts` bounds what this process sends a provider, however many
visitors ask. A token bucket rather than a flat interval, because a real pan
fires several `moveend`s and then nothing for a minute; one bucket per
provider, shared by both road routes because it is the provider being
protected and not a route. Never per-IP, and a refusal never blocks a visitor
-- it takes the same stale-then-remembered path an outage does.

`layers/bbox.ts` owns the `?bbox=` pipeline: `parseBbox` (four finite numbers
as `minLng,minLat,maxLng,maxLat`), `clampBbox` (shrunk around its own centre
to at most two degrees a side, never rejected), `roundBbox` and
`bboxCacheKey`. Rounding snaps outward to a 0.05-degree grid, and both halves
matter: to a grid at all, because panning changes the viewport every frame and
would otherwise miss the cache on every request; outward rather than to the
nearest line, because rounding each edge independently collapsed any viewport
narrower than one cell to zero area and emptied the layer on zooming in.
`layers/point.ts` does the equivalent for `?lat&lng`, rounding to two decimals
-- the precision `web/geolocation.ts` applies in the browser -- before both
the cache key and the upstream call, and deliberately sharing none of
`bbox.ts`'s clamping.

### Settings store

`settings/store.ts` persists `Settings` as JSON at `SETTINGS_FILE`, default
`data/settings.json`. A missing file means in-memory defaults with writes
allowed; a corrupt one means defaults for reads but every write refused with
`SettingsWritesRefusedError` (a `503`) until a human fixes the file and
restarts -- there is no repair-in-place. A write goes to a `.tmp` sibling and
is `rename`d over the real path, writes are chained onto one promise so they
apply in call order, and unknown top-level keys already in the file are
carried through verbatim rather than dropped.

`settings/auth.ts` guards the write surface; reads are public. Every write and
`POST /api/settings/login` goes through `requireSettingsPassword`, comparing
`Authorization: Bearer <password>` against `SETTINGS_PASSWORD`. There are no
accounts, no sessions and no server-issued token -- the settings password
itself is the credential. Both sides are hashed to a fixed-length digest
before `timingSafeEqual` so a wrong-length guess cannot take a different path,
every failure costs a fixed delay, and there is deliberately no per-IP counter
or lockout. `isAuthorizedRequest` is the non-gating variant `/api/weather`
uses to decide content rather than access; it charges a present-but-wrong
header the same delay, so it cannot be a faster oracle than the login route.

### Background work

`trails/` is the BFF's memory of where ships and aircraft have recently been,
since neither provider serves history. `store.ts` keeps a bounded number of
points per vessel, drops them past a maximum age, forgets a vessel unseen for
an hour, lives in memory only, and doubles as the last-known-good a route
falls back to during an outage. `poller.ts` keeps it fed while nobody is
asking: it polls the fixed `TRAILS_AREA_BBOX` every `TRAILS_POLL_SECONDS`
(default 30), so a trail already exists when someone walks up rather than only
accumulating for whatever viewport a browser happened to be polling. It never
throws and never lets one failure end the schedule. `support.ts` wires both
stores to the shared snapshot and gate and hands `app.ts` one start/stop.

### Provider modules

`ships/` talks to BarentsWatch: `token.ts` caches the OAuth2 token and
refreshes at 80% of its `expires_in`; `barentswatch.ts` fetches
`GET /v1/latest/combined` -- nationwide, because the bbox-filtered endpoint
returns positions without names -- and maps it to the shared `Ship` shape,
with `shipsWithin` doing the viewport filtering; `snapshot.ts` holds one
nationwide snapshot per process, gated on the last _attempt_ rather than the
last success, so fifty viewports cost one multi-megabyte download and a
failing upstream is not retried once per visitor.

`aircraft/provider.ts` speaks to three keyless community aggregators sharing a
readsb/tar1090-style shape (adsb.lol captured live, airplanes.live and adsb.fi
parsed tolerantly against the same schema) plus OpenSky, implemented
best-effort from public documentation. `flight-routes.ts` resolves a callsign
to origin and destination against adsbdb, answering purely from cache: nothing
blocks, a callsign first seen on one poll shows its route on the next, and a
failed lookup is invisible.

`aurora/ovation.ts` is NOAA SWPC's OVATION model -- the one provider fetched
solely to enrich an upstream document. Its ~918 KB global grid is fetched once
per process per refresh window, indexed into a small typed array with the
parsed JSON dropped, and never sent to a browser; the response carries one
number. Every path returns `null` rather than throwing, since its absence must
not cost the aurora page.

`roads/` is Statens vegvesen. `vegvesen-wfs.ts` is the only place that talks to
the OGC GeoServer and the only place that builds a WFS `bbox` (the axis order
is a trap -- see the gotchas below and ADR 0004). `situations.ts` groups
upstream's main and consequence records into one road situation and classifies
each from the clock rather than upstream's `ACTIVE` flag. `road-cameras.ts`
joins the camera layer to the co-located road-weather stations, treats the
weather half as droppable, and asserts the image host server-side because the
browser fetches each still directly. `simplify.ts` runs Douglas-Peucker and
coordinate rounding once, on the server. `discards.ts` counts what a mapper
refused and why, so an upstream attribute rename surfaces as a log line rather
than a plausible-looking empty layer.

### Logging

`buildApp` installs its own `req` serializer, `logRequest`, in place of
Fastify's default: it records the method, the client address and the route
_template_ (`/api/weather`), never `req.url` with its query string. That is a
privacy choice -- `/api/weather` and `/api/tide` take `?lat&lng`, so the
default serializer would write a stream of visitor positions into the
container log. `serveCached`'s `logKey` covers the error path for the point
caches, and `roads/discards.ts` logs counts and reason names but never a bbox
and never a coordinate.

## Frontend

### Reactive core

`src/web/core/` is a small hand-written reactive core
(`signal`/`computed`/`effect`), a polling `resource` built on it, a
hash-fragment `router`, and two minimal DOM helpers (`h`/`bind`). See
[`docs/REACTIVITY.md`](REACTIVITY.md) for how the tracking mechanism works and
why it's built this way.

### Shell

`src/web/main.ts` applies device settings before mounting anything, imports the
router for its side effect, then mounts the app shell, the night/brightness
overlay and idle-reset.

`shell/AppShell.ts` is the frame every page lives in: masthead and footer line
mount once for the app's lifetime, and the active page is re-mounted by a
single top-level effect that disposes the previous page before mounting the
next -- skipping that leaks an effect or timer per navigation on a display
that runs for weeks. Every navigation is a slide, so two pages are briefly
alive at once.

`shell/Masthead.ts` is one row: the page tabs on the left, from `NAV_PAGES`
filtered by `settings.enabledPages`, and on the right the live-layer counts,
the stale banner, the weekday, date and clock, and the settings gear. Counts
are keyed by `LiveLayerGroupId` in `shell/page-status.ts` -- `ships`,
`aircraft`, `roadSituations`, `roadCameras` -- plus a separate `hiddenByAge`
summed across the layers that have an age filter at all. `page-status.ts` is
the whole page-to-chrome channel (freshness, attribution, layer counts and
listing, the settings page's account line): a page claims those slots on mount
and releases them on dispose, with a generation counter so the outgoing page's
last poll cannot overwrite the incoming page's values mid-slide.

`shell/FooterLine.ts` shows the attribution the current page supplies,
replaced by a note while the night schedule is active. It survives the
2026-09-07 design's removal of the footer only because several providers
require visible credit as a licence condition; the relative "updated ... ago"
moved to the masthead's stale banner, driven by `shell/staleness.ts` --
`isStale` (older than three poll intervals) and `formatAge`, the same compact
age map popups use.

The rest: `autoCycle.ts` is the kiosk slideshow, splitting the pure "what is
next" from the timer, and independent of idle by design. `idle.ts` fires after
`settings.idleResetSeconds` of no touch and also dispatches
`IDLE_RESET_EVENT`, for a page already mounted on the idle destination that
would see no route change. `night-schedule.ts` evaluates `settings.night`
against the device clock once a minute and `DisplayOverlay.ts` draws the
result -- one full-screen `pointer-events: none` veil following
`settings.brightness`, overridden to dim or fully dark while the schedule is
active and lifted for 30 seconds by any tap, except in `dark` mode where there
is no veil and `theme.ts` forces the dark theme instead. `theme.ts` also
applies the device's own `theme` and `fontScale`, with `system` following
`prefers-color-scheme`. `resourceStatus.ts`'s `createFreshnessReporter` is the
shared wiring from a page's `resource()` state to `pageFreshness`, remembering
the last success across a later error.

### Pages

`pages/registry.ts` maps every route to its page module and to the i18n keys
the masthead needs. `NAV_PAGES` is the tab row; the route map is a superset,
because the cameras entry is registered as a route unconditionally while kept
out of the tabs, so an old `#/cameras/<id>` bookmark still resolves. Settings
is a gear link rather than a tab.

`MapPage.ts` imports Leaflet dynamically inside `render()`, so the library is
its own lazily-loaded chunk. Under `pages/map/`: `tiles.ts` is the only file
allowed to name a tile URL and resolves the `dark`, `light` and `satellite`
basemaps (or `auto`, following the theme); `layers.ts` is the live-layer
registry, the one thing `MapPage.ts` calls (`mountLiveLayers`), with
`liveLayerMount.ts` holding the reusable half -- mount and unmount on
`settings.<id>.enabled`, `mapToBboxQuery` and `refetchOnMapMove`. `ships.ts`
draws heading-rotated triangles through `canvasGlyphLayer.ts` and pulls
overlapping ones into numbered badges using `clustering.ts`'s pure
screen-pixel geometry; `aircraft.ts` does the same without clustering.
`roads.ts` draws one pin per road situation carrying a real vendored Statens
vegvesen sign face from `signs/` for what it is and a colour for what state it
is in, plus a simplified line along the stretch. `roadCameras.ts` drops a
muted pin per road camera on its own fixed poll and opens `cameraModal.ts`, a
full-screen overlay rather than a Leaflet popup, with a lazily-loaded grid of
a site's other orientations. Terje's own cameras stay hand-wired outside that
registry, in `markers.ts` (whose `computeMarkerData`/`diffMarkers` are pure
and Leaflet-free) and `popup.ts`.

`WeatherPage.ts`, `AuroraPage.ts` and `TidePage.ts` each poll their own
endpoint through a `resource()` created per mount and disposed on unmount --
deliberately not module-scope singletons, so one page's failing fetch cannot
affect another's. `CamerasPage.ts` and `CameraViewerPage.ts` share the
`camera-resource.ts` singleton instead, and neither is reachable while
`pages/cameras/dormancy.ts`'s `CAMERAS_DORMANT` is `true`. That one flag is
read by six modules -- `pages/registry.ts`, `shell/autoCycle.ts`,
`pages/settings/General.ts`, `pages/SettingsPage.ts`, `pages/map/markers.ts`
and `pages/map/popup.ts` -- so flipping it restores the tab, the slideshow
entry, the settings section, the map pins and the popup link in one edit.

`SettingsPage.ts` and `pages/settings/` are a section sub-nav over
`Cameras.ts`, `Map.ts`, `Display.ts`, `Layers.ts`, `General.ts` and
`Account.ts`: autosave everywhere, no save button anywhere. Shared-setting
controls render read-only while logged out behind one "Logg inn" button;
device settings stay editable regardless. `Layers.ts` is generated from
`src/shared/layers.ts` rather than naming any layer, apart from a few
deliberate, documented per-layer exceptions.

### Settings client

`src/web/settings/session.ts` is the storage primitive: the password itself is
the credential, held in `localStorage` once a login attempt has been confirmed
against `POST /api/settings/login` and handed back as an
`Authorization: Bearer` header for every write. No expiry and no idle clearing
-- a logged-in device stays logged in until an explicit logout or a `401` from
a real write.

`sharedStore.ts` is the write-capable view the settings page mounts, kept
separate from `settings-resource.ts`'s read-only singleton every other page
reads. It polls `GET /api/settings` every 30 seconds, applies an edit
optimistically, sends `PATCH /api/settings` (or `PUT`/`DELETE` for a
placement), and merges each incoming snapshot against a reference-counted
`pendingFields` map, so a poll predating an unflushed edit updates every other
field without clobbering that one. `autosave.ts` is the one engine behind
every control -- immediate for toggles, selects and steppers, debounced with a
`flush()` on blur or Enter for typed fields, and a status that never
auto-clears an error. `localOverrides.ts` holds the shared fields this device
shadows locally and never sends to the server; `device-settings.ts` holds the
ones with no shared counterpart at all -- theme, font scale, basemap choice.

### Strings, components and styling

`src/web/i18n/` is hand-rolled. `nb.ts` is the source of truth, declared
`as const`, and `en.ts` is typed `Record<keyof typeof nb, string>`, so a
missing or extra key fails `npm run typecheck` rather than surfacing on the
display. `t()` reads `currentLanguage` (derived from `settings.language`)
reactively, so switching language re-renders text in place with no reload, and
each key's `{placeholder}`s are extracted from the literal Norwegian string by
template-literal types, making a misspelled parameter a compile error too.

`src/web/components/` holds the shared touch-sized controls: `Toggle`,
`SelectField`, `Stepper`, `NumberField`, `TimeField`, `StatCard`, `ErrorBand`,
`ImageWithAge`, `SaveIndicator`, `LoginDialog` and `OnScreenKeyboard`.
`src/web/styles/` is `tokens.css` -- the only file allowed to contain a raw
hex colour -- plus `fonts.css` and `base.css`, with the tokens adapted from
the vendored design reference in `design/`.

### The live-layer contract

`src/shared/layers.ts` carries exactly the facts that must never drift between
server and browser: a `LiveLayerSpec` holds the layer's `id`, its shared Zod
response schema, its default poll cadence and that cadence's floor and
ceiling, and its attribution. `LiveLayerId` is the closed union
`'ships' | 'aircraft' | 'roads'`, because an id is simultaneously the
`/api/<id>` route segment, the `settings.<id>` key and a `SettingsOverride`
key. `maxAgeMinutesMin`/`maxAgeMinutesMax` are optional: they bound a "hide
fixes older than this" control, which presumes a layer of position reports. A
road situation has a validity window instead -- it is not stale at 22:00, it
is `scheduled` -- so the Vegvesen layer sets neither and the settings page
renders that stepper only for the layers that do. It is also why `id` is not
one-to-one with a route: `roads` is two routes behind one toggle.

`src/shared/schemas/` holds the Zod schemas both sides import, so the browser
parses a response against the same definition the BFF validated it with.
Captured fixtures live in `src/shared/fixtures/` for upstream payloads and in
a `fixtures/` directory beside each provider module, each with a README saying
where it came from and how to recapture it.

## Data flow

**A live layer poll.** A visitor drags the map; Leaflet fires `moveend`,
`refetchOnMapMove` debounces it (ignoring the programmatic moves a follow
produces) and calls the layer's `resource().refresh()`, which fetches outside
the poll rhythm and restarts the interval. The layer reads the viewport
through `mapToBboxQuery` and requests `GET /api/<id>?bbox=`. On the server that
box goes through `parseBbox`, `clampBbox` and `roundBbox`, and `bboxCacheKey`
becomes the key `serveCached` reads. A fresh hit comes straight from
`TtlCache`; a miss calls the provider -- for ships a `shipsWithin` filter over
the shared nationwide snapshot, for aircraft and the roads a real outbound
request that must first take a token from that provider's `OutboundGate`,
degrading to the stale entry and then to remembered items if it cannot. The
result is validated against the shared schema, decorated with each item's
trail, and sent with an `ETag` and a `max-age` from the route's TTL. The
browser parses it against that same schema and the layer diffs it against what
is on screen, updating markers and lines in place, then reports its count and
attribution through `page-status.ts` for the masthead and footer line.

**A settings change.** A visitor touches a toggle. The control mutates the
local value and calls `trigger()` on its `autosave.ts` instance -- immediately
for a toggle, after the debounce window for a typed field. `sharedStore.ts`
marks the affected top-level fields pending, applies the value optimistically,
and sends `PATCH /api/settings` with `Authorization: Bearer <settings
password>` from `session.ts`. On the server `requireSettingsPassword` checks
the header, a strict patch schema parses the body (an unrecognised key is a
real 400, not a silent no-op), and `SettingsStore` merges, writes a `.tmp`
file and renames it over `data/settings.json`, answering with the whole new
document -- which replaces the optimistic value and releases the pending
marks. Every other device, and every other page on this one, picks the change
up on the next poll of `GET /api/settings`, which both `settings-resource.ts`
and `sharedStore.ts` run every 30 seconds; the route sends
`Cache-Control: no-store`, so nothing in between can serve a stale answer.

**Startup.** `index.ts` calls `loadConfig()`, which throws on a missing or
short `SETTINGS_PASSWORD` before anything else happens. `buildApp` registers
compression, then the routes in the order above -- settings before weather --
building the shared BarentsWatch token, AIS snapshot and outbound gates as it
goes, and finally the static plugin if a frontend build exists on disk.
Fastify's `onReady` hooks then run: the settings store loads its file, so the
first request can never see an unloaded store, and the trail poller starts
with an immediate round before settling into its interval. Only then does
`app.listen` bind `127.0.0.1:8141`. On close the poller's stop function runs,
so no timer outlives the instance that owns it.

## Known gotchas

Found via a live browser + real backend sweep after phases 0-10 had already
merged with ~570 passing unit tests. None of these were caught by that test
suite — happy-dom doesn't do real layout, and mocked fetch/fixtures don't
capture what a real upstream actually sends. **A periodic sweep against a
real browser and real live data is not optional polish; it is the only thing
that has ever caught this class of bug here.** The last three entries were
added in phase 12 and found the same way, by probing the real service
instead of believing its documentation.

- **CSS percentage-height chains break silently under flex.** For a
  descendant's `height: 100%` to resolve, every ancestor up to `html` needs a
  _definite_ height, and `min-height` doesn't count even when flex-grow makes
  the element visually fill the space. This made the map render at `height:
0` (`.leaflet-container` computed to 0px while its flex-grown ancestor had
  a real 709px) despite tiles fetching successfully -- nothing errored, the
  map was just blank. Fixed by giving `html, body` an explicit `height: 100%`
  (`src/web/styles/base.css`) and `#app` a `height: 100vh`, not just
  `min-height: 100vh` (`src/web/shell/shell.css`).
- **Real upstream data is messier than a schema written from one fixture.**
  `/api/weather`'s `netatmo` field can be `null` (the real Netatmo station
  goes offline for real) and `current.rain.{current,last_hour,last_24h}` can
  be entirely absent -- the schema required them, so a real degraded-but-
  valid upstream response caused a full 502 in production. Separately,
  BarentsWatch's real AIS feed sends `name: null` for some vessels (3 of
  ~4000 in one live sample) even though the schema required `z.string()`.
  Model the nullability actually observed (or documented) upstream, not just
  the shape one captured fixture happened to have; capture a fresh real
  fixture when in doubt (see `src/shared/fixtures/README.md`).
- **An object-literal shorthand property snapshots a value; it does not stay
  bound to the variable.** `{ isPlaced }` copies whatever `isPlaced` holds
  _at that moment_ into the returned object -- it is not a live reference,
  so a later reassignment of the `isPlaced` variable never reaches a caller
  already holding the object. This left the settings page's camera status
  badge showing stale "no placement" after a placement loaded async. Fixed
  in `src/web/pages/settings/Cameras.ts` with `get isPlaced() { return
isPlaced; }` -- a live getter, not a copied value.
- **A `200` response is not proof a third-party request succeeded.** CARTO's
  basemap tiles (`{s}.basemaps.cartocdn.com/dark_all/...`) now require a
  `key` query parameter, but an unauthenticated request still returns `200
image/png` -- it's just watermarked "API key required" in the pixels. A
  status-code check (or an inattentive glance) would never catch this; only
  diffing the actual image bytes against a keyed request did. See
  `src/web/pages/map/tiles.ts` and ADR 0003.
- **A WFS `bbox` is longitude-first, and getting it wrong returns `200` with
  nothing in it.** The WFS specification suggests a lat-first axis order for
  EPSG:4326, and Statens vegvesen's GeoServer wants
  `minLng,minLat,maxLng,maxLat,EPSG:4326` -- the same order this app's own
  `?bbox=` uses. Hand it the spec's order and it does not complain: it
  matches _nothing_, 0 features where the correct order returns 54 for the
  same Vesterålen box. That failure is invisible by construction, because an
  empty road-notice list looks exactly like "nothing is happening on the
  roads", which is a perfectly plausible answer most of the time. Only
  `src/server/roads/vegvesen-wfs.ts` builds the parameter, and
  `vegvesen-wfs.test.ts` asserts the literal string it produces. Output
  coordinates are ordinary GeoJSON `[lng, lat]`, swapped to Leaflet's
  `[lat, lng]` once, in `roads/situations.ts`.
- **An upstream flag named `ACTIVE` did not mean "happening now".** On
  `datex_3_1:SituationSimple_v2` it is `1` only for a situation that _has_
  validity periods (`NUM_PERIODS > 0`, e.g. "08:00-21:00 weekdays") and is
  inside one at this moment. A situation with no periods at all is never
  `ACTIVE`, however live it is: 997 probed situations sat inside their own
  `START_TIME..END_TIME` window carrying `ACTIVE=0`, and the wind warnings
  on Tjeldsundbrua were among them. Filtering on the obvious-looking flag
  would have dropped exactly the notices a wall display exists to show, and
  left a map that looked healthy. "Current" is instead computed from the
  timestamps, with `ACTIVE` consulted only when there are periods
  (`classifySituation` in `src/server/roads/situations.ts`). See also
  ADR 0004.
- **A hand-authored fixture can only test the field name its author
  guessed.** Three upstream attribute names were written into the phase plan
  from memory and into fixtures from the plan: `LOCATION_DESCRIPTOR` for
  what is really `LOCATION_DESCRIPTION`, `MAX_WIND_SPEED` for
  `MAXIMUM_WIND_SPEED`, and a main-record flag assumed not to exist at all
  when upstream in fact publishes `IS_MAIN_RECORD`. Every test built on
  those fixtures passed, because the fixtures agreed with the code about a
  name the service has never used -- in production those fields would simply
  have been `null`, so road notices would have had no place name and every
  wind gust would have been missing. One `DescribeFeatureType` call settled
  all three. Capture fixtures from the real service, or at minimum check the
  field list against it before writing a schema; this is the same lesson as
  the nullability entry above, one step earlier.
