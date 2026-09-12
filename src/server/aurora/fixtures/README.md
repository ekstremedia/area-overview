# Aurora fixtures

## `ovation-sample.json`

A trimmed capture of NOAA SWPC's OVATION aurora model, taken from the real
endpoint on 2026-09-12:

```
curl https://services.swpc.noaa.gov/json/ovation_aurora_latest.json
```

The full response is ~918 KB: 65 160 points covering the whole globe on a
1°×1° grid, as `[longitude, latitude, probability]` triples with longitude
running 0–359 rather than −180–180. This fixture keeps 1 281 of them — the
latitudes this app cares about (55–75°N) across the longitudes around
Norway — which is enough to exercise real indexing, including the
wrap-around at the antimeridian, without carrying a megabyte in the repo.

Two values in it are load-bearing, and both were checked against the live
endpoint at capture time:

- Sortland (68.6984, 15.4129) → **9**
- Oslo (59.91, 10.75) → **0**

They are asserted by `ovation.test.ts`. If NOAA ever changes the grid
resolution or the coordinate ordering, those two assertions are what will
notice.

The `Observation Time` and `Forecast Time` fields are kept verbatim from
the capture, so the fixture also pins the timestamp shape the schema
parses.
