# Statens vegvesen (Veg layer) fixtures

Three GeoJSON `FeatureCollection`s standing in for the keyless OGC
GeoServer at `https://ogckart-sn1.atlas.vegvesen.no/ows`:

| File                         | Stands in for                  | Used by                                                         |
| ---------------------------- | ------------------------------ | --------------------------------------------------------------- |
| `situations-vesteralen.json` | `datex_3_1:SituationSimple_v2` | `../situations.test.ts`, `../../routes/road-situations.test.ts` |
| `cctv-vesteralen.json`       | `datex_3_1:CctvSimple_v2`      | `../road-cameras.test.ts`, `../../routes/road-cameras.test.ts`  |
| `weather-vesteralen.json`    | `datex_3_1:WeatherSimple_v2`   | `../road-cameras.test.ts`, `../../routes/road-cameras.test.ts`  |

## Hand-authored values, confirmed attribute names

Unlike `../../aircraft/fixtures/adsb-lol-live.json`, nothing here came off
the wire: every **value** is written by hand. The **attribute names** are
not guesses, though -- all three layers were run through
`DescribeFeatureType` on 2026-09-13 (the command is in
`plans/Vegvesend.md`'s appendix), and every name used here and in the code
that reads it comes from that output. Notably:

- The situations layer really does carry **`IS_MAIN_RECORD`**, so
  main-versus-consequence is upstream's own statement rather than
  something this app infers from `SITUATION_TYPE`.
- The place name is **`LOCATION_DESCRIPTION`**. There is no `AREA_NAME`
  or county attribute on that layer to fall back to.
- The gust is **`MAXIMUM_WIND_SPEED`** on the weather layer; there is no
  `MAX_WIND_SPEED`. Precipitation is `PRECIPITATION_INTENSITY`.

The shapes otherwise follow what the probe recorded: flat `_v2`
attributes in `SCREAMING_SNAKE_CASE`, `[lng, lat]` coordinates,
`2026-09-13T19:05:00+02:00` timestamps with a real offset, `|` as the line
break inside `DESCRIPTION`, `null` (not an absent key) for a missing
reading, and records ordered newest-first the way
`sortBy=LAST_UPDATE_TIME D` delivers them -- which is why the consequence
record of a group arrives _before_ its cause here.

So these pin **this app's handling** of the real shapes, not upstream's
exact bytes. Every value is public road data; there is nothing to redact.

## What each case is for

`situations-vesteralen.json` -- 13 records, 11 situations:

- **NPRA_1001** Sortlandsbrua: a main record **plus a consequence record**
  sharing its `SITUATION_ID` and repeating its geometry, the way upstream
  publishes every non-trivial notice. The consequence record was edited
  last and so arrives _first_, which is what makes `IS_MAIN_RECORD` earn
  its keep. Periodic (`NUM_PERIODS: 2`) and `ACTIVE: 1`, so it is
  `current`. Its `DESCRIPTION` carries a `|`, and the consequence
  record's `SECONDARY_TYPES` is the comma list
  `"laneClosures,narrowLanes"`.
- **NPRA_1002** Tjeldsundbrua: a wind warning with **`ACTIVE: 0` and no
  validity periods**, inside its window. It must classify as `current` --
  reading `ACTIVE` as "happening now" would hide it. It has a
  `LineString`, which must **not** travel as `line`: lines are for
  closures and roadworks only.
- **NPRA_1003** Glåmvika: a closure (`roadClosed` on the consequence
  record), `END_TIME: null` (open-ended), and a `MultiLineString`. This is
  the one situation that stays `current` for any clock after August 2026,
  which is what the route tests anchor on.
- **NPRA_1004** Sløverfjordtunnelen: starts in a week -- `planned`.
- **NPRA_1005** Bjørnskinn: starts in seven weeks -- past
  `PLANNED_HORIZON_DAYS`, dropped entirely.
- **NPRA_1006** Stokmarknes: ended three days ago -- `expired`, dropped.
- **NPRA_1007** Sortland sentrum: inside its window, `NUM_PERIODS: 3`,
  `ACTIVE: 0` -- `scheduled`. Roadworks with a `Point` geometry, so no
  line either.
- **NPRA_1008** Melbu-Fiskebøl: a ferry notice (`TransitInformation`).
- **NPRA_1009** Raftsundet: an accident, in force at the fixed test clock.
- **NPRA_1010** E10 Vesterålen: a **421-point line**, standing in for the
  497-point, 416 KB features upstream really sends. It exercises
  Douglas-Peucker (it simplifies to about 30 points).
- **NPRA_1011** Kvitnes: a consequence record (`IS_MAIN_RECORD: 0`)
  **with no cause record** -- `kind: 'management'` -- with `null` road
  number, no location attribute and no geometry at all.

The fixed clock the unit tests use is `2026-09-13T12:00:00+02:00`. The
route tests run on the real clock and therefore assert only on NPRA_1003
and NPRA_1011, the two open-ended situations.

`cctv-vesteralen.json` -- 9 cameras:

- **3000957_1..\_4** Hadselbrua: a four-orientation site, all four sharing
  one coordinate exactly (which is what lets the map's generic clustering
  be the site grouping).
- **3000420_1** Tjeldsundbrua øst: has a co-located weather station.
- **3000551_1** Sortlandsbrua: has **no** weather station.
- **3000700_1** Raftsundet: `videoOrImagesUnavailableDueToCameraFault` --
  dropped, and its station's readings must go with it.
- **3000888_1** Bø: `STILL_IMAGE_URL` on a **foreign host** -- rejected by
  the server-side host assertion, so no visitor's browser is ever pointed
  at it.
- **3000905_1** Lødingen ferjekai: `null` orientation and road number.

`weather-vesteralen.json` -- 5 stations:

- **3000420** carries `WIND_SPEED: 14.8` with `MAXIMUM_WIND_SPEED: 54.4`,
  at 9.2 °C. **These are real numbers**, not invented: station 1800428
  reported exactly this through this route at 20:30 on 2026-09-13. A
  54.4 m/s gust is 196 km/h, against a measured mean of 14.8 -- a gust
  factor of 3.7 where real weather produces 1.3-1.6, on a calm September
  evening. It is a sensor artifact, and it sits comfortably under the
  60 m/s absolute cap, which is why `road-cameras.ts` also judges a gust
  against its own mean (`MAX_PLAUSIBLE_GUST_RATIO`). Here the gust
  becomes `null` and the 14.8 mean is served as measured.
  The cases the ratio must _not_ touch -- a real 28/41 storm, a gust from
  a station with no mean, near-calm air -- are asserted directly in
  `../road-cameras.test.ts` rather than through this fixture.
- **3000957** Hadselbrua: nulls where the station measures nothing.
- **3000700** Raftsundet: a full set of readings for the site whose only
  camera is faulted -- it must not reach the response.
- **3009001** Blomjoten: a station with **no camera at all** in the
  viewport -- ignored, because `weatherBySite` exists to annotate a
  picture.
- **3000905** Lødingen: `MEASUREMENT_TIME: null` -- a reading of unknown
  age, dropped.

## Re-probing

The commands are in `plans/Vegvesend.md`'s appendix. Note the trap they
encode: `bbox` is `minLng,minLat,maxLng,maxLat,EPSG:4326`, and the other
axis order returns an empty, entirely valid-looking answer.
