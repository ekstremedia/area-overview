# 0004: Statens vegvesen's keyless OGC layers, and Terje's own cameras go dormant

## Context

The map shows the ships and aircraft passing through one stretch of coast,
and it showed Terje's own webcams. It said nothing about the roads in the
same view -- the roadworks on Sortlandsbrua, a closed Fv. 7542, a wind
warning on Tjeldsundbrua, a ferry notice at Melbu -- and nothing about
Vegvesen's own cameras, which sit on exactly the bridges, tunnels and ferry
quays this display is pointed at.

Statens vegvesen publishes that data twice. The **Datex II node**
(`datex-server-get-v3-1.atlas.vegvesen.no`) is the documented, canonical
one: XML, and it answers `401` with `Www-Authenticate: Basic`. Credentials
are obtained through a web form asking for an organisation number and a
**fixed IP address**, and are described as confidential -- a real obstacle
for an app that would have to carry them into a container on a home
connection. An **OGC GeoServer** (`ogckart-sn1.atlas.vegvesen.no/ows`)
serves the same records as WFS 2.0.0 with GeoJSON output, under NLOD, and
its licence page says in as many words that no user has to be registered in
advance.

Separately, Terje's own cameras are two devices, one of which is online,
and they come down when he moves. They are the weakest thing on the map,
and they are about to be the only reason several pages, routes and schema
fields exist.

## Decision

**Take the keyless GeoServer.** The Veg layer reads three flat feature
types -- `datex_3_1:SituationSimple_v2` (road notices),
`CctvSimple_v2` (road cameras) and `WeatherSimple_v2` (road weather) --
over plain WFS `GetFeature` with `outputFormat=application/json`. The
non-`_v2` layers wrap the same data in a nested Datex object and are
ignored. Nothing in this app speaks Datex II, and it holds no Vegvesen
credential of any kind; `src/server/roads/vegvesen-wfs.ts` is the single
place that builds a request to it.

**Two routes behind one toggle.** `GET /api/road-situations` (120 s TTL)
and `GET /api/road-cameras` (300 s TTL) are separate, but the user sees one
layer with one on/off switch and one settings block. The camera roster
barely changes and its pictures refresh in the browser as an `img.src` swap
that costs the API nothing, so a combined route would have re-fetched the
cameras twice as often as they change; and a camera-side outage cannot
blank the road notices. Both routes are per-viewport, not a nationwide
snapshot: the GeoServer filters by bbox itself in 0.2 s, so there is nothing
to gain by holding 3 MB of the whole country in memory.

**One situation, one geometry, one pin.** Upstream delivers a road notice
as a main record (the cause) plus N consequence records (lane closures,
speed limits, diversions) that share a byte-identical geometry -- 947 of
947 multi-record situations in a nationwide probe. The server groups them
by `SITUATION_ID` and emits one object with one geometry. Which record is
the cause is **given, not derived**: the layer carries an explicit
`IS_MAIN_RECORD` attribute, and the list of consequence-shaped types
survives only as a fallback for a group where no record is flagged.
Geometry is simplified server-side (Douglas-Peucker at ~20 m, five
decimals) because one real feature was a 497-point, 416 KB line.

**Lines only where extent means something.** A closure and a roadworks
stretch are drawn as polylines because _where they start and stop_ is the
information. Everything else -- wind warnings, accidents, ferry notices --
travels and draws as a pin, even when the data carries a geometry for it,
because a 12 km line across a fjord crossing says something about a wind
warning that is not true. Every feature carries display coordinates, so a
pin is always available.

**Status is recomputed on every response, never cached.** What the cache
holds is upstream's raw records; `current`/`scheduled`/`planned` is derived
on the way out, on every single response, fresh or stale. `TtlCache` has no
maximum stale age and deliberately serves a stale entry when a refresh
fails, so a cached status would mean that during a GeoServer outage a
roadwork that ended hours ago went on being served as `current` -- a
timestamp-shaped lie told with full confidence, for as long as the outage
lasted.

**A road camera is not a camera.** They are different things with different
lifecycles and they never share a word: a **Camera** is Terje's own and
needs a placement; a **Road camera** is Vegvesen's, arrives with its own
coordinates, and belongs to the Veg layer. `CONTEXT.md` carries the
vocabulary.

**Terje's own cameras go dormant, not deleted.** One flag,
`CAMERAS_DORMANT` in `src/web/pages/cameras/dormancy.ts`, read by six
modules, stops the app _showing_ them: no camera pins, no popup link, no
masthead tab, no slideshow slot, no placement editor. Nothing is removed.
`'cameras'` stays in `PageIdSchema` and in the router union, the
`#/cameras/<id>` route still resolves, `placements` stay in the settings
schema and on disk, and `CameraViewerPage.ts` is untouched. Deleting would
have been a schema migration and a broken bookmark in exchange for nothing;
a flag flip brings the feature back in one edit.

**Norwegian message text is shown verbatim, in both UI languages.** NPRA's
terms for this data state that the Norwegian messages cannot be translated,
so `DESCRIPTION` is rendered exactly as it arrives -- machine translation
of a road notice is precisely the wrong place to be approximately right.
The English UI puts a small "Statens vegvesen" note under it, so the
language switch reads as a source note rather than a bug.

**Sign artwork is vendored, under NLOD.** The pins draw the real Vegvesen
sign faces (110 Vegarbeid, 302 Innkjøring forbudt, 775 Bilferje, 156 Annen
fare) from the Geonorge symbol package, committed under
`src/web/pages/map/signs/` with a `README.md` recording the source, the
licence, what was changed and why the faces are only ever drawn small,
inside a pin or beside a popup heading. A sign a driver already knows is
read across a room faster than any icon this project could invent.
Attribution is required: the full NLOD sentence lives in `README.md` and in
that directory's `README.md`, and the map footer carries the short form
`Data: Statens vegvesen`.

**Camera stills are hotlinked, never proxied.** The browser fetches
`https://kamera.atlas.vegvesen.no/api/images/<id>` itself, as it already
does for the basemap tiles and NOAA's aurora-oval image; the BFF never moves
image bytes. The host is asserted server-side, so a future upstream change
cannot quietly make this app hotlink somewhere else.

## Consequences

- **The bbox is lng-first, and the alternative fails silently.**
  `minLng,minLat,maxLng,maxLat,EPSG:4326` is what this service wants; the
  lat-first axis order the WFS specification suggests for EPSG:4326 does
  not error, it matches _nothing_ -- 0 hits versus 54 for the same
  Vesterålen box. An empty result is indistinguishable from a quiet day on
  the roads, so this is pinned by a test asserting the literal query
  string, and recorded again in `docs/ARCHITECTURE.md`.
- **`ACTIVE` does not mean "happening now".** It is `1` only for a
  situation that has validity periods and is inside one at this moment;
  997 probed situations sat within `START_TIME..END_TIME` with `ACTIVE=0`,
  the wind warnings among them. "Current" therefore has to be computed
  from the timestamps, with `ACTIVE` consulted only when `NUM_PERIODS > 0`.
  Also in `docs/ARCHITECTURE.md`, because that is where it will be looked
  for.
- **No SLA, and no credential to lean on.** An outage means a stale cache,
  then a 502, then the web layer keeping its last good response -- the same
  path every other upstream takes here. The keyless service could also
  start asking for a key; the fallback would be the Datex node and its
  fixed-IP form, which is the decision above taken again with worse
  options.
- **A dense viewport truncates.** The situations query asks for the 500
  most recently updated records, so what survives a truncation is the
  freshest rather than an arbitrary page. It is logged when it happens;
  Vesterålen is 54.
- **The dormancy flag is a promise to keep code that nothing runs.**
  `CameraViewerPage.ts`, `ImageWithAge.ts` and the placement editor still
  compile and are still tested, but no visitor reaches them. That is the
  cost of being able to flip one boolean when Terje's cameras come back up
  somewhere else.
- **The signs are third-party artwork in the repository.** They carry an
  attribution obligation that outlives whoever remembers adding them,
  which is why it is written down in three places rather than one.
