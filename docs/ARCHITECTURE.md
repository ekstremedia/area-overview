# Architecture

This document is filled in incrementally as later phases land. Phase 0 only
establishes the skeleton below.

## Overview

area-overview is a reactive vanilla-TypeScript frontend (no framework) paired
with a small Node/TypeScript backend-for-frontend (BFF). The BFF proxies and
shapes data from the Laravel API at `nesthus.no` for consumption by the
frontend, and keeps upstream credentials off the client.

## BFF

_To be documented in phase 2 (the BFF server) and phase 3 (settings store)._

## Frontend

Phase 4 adds `src/web/core/`: a small hand-written reactive core
(`signal`/`computed`/`effect`), a polling `resource` built on it, a
hash-fragment `router`, and two minimal DOM helpers (`h`/`bind`). See
[`docs/REACTIVITY.md`](REACTIVITY.md) for how the tracking mechanism works
and why it's built this way.

_App shell/design system (phase 5) and individual pages (phase 6 onward)
remain to be documented._

## Data flow

_To be documented once live layers (phase 7) and the settings page (phase 9)
land._

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
