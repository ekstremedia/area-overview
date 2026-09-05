# Aircraft (ADS-B) fixtures

## Live-captured

`adsb-lol-live.json` was captured 2026-09-05 by running, directly, during
this phase's development:

```
curl 'https://api.adsb.lol/v2/lat/68.6984/lon/15.4129/dist/100'
```

This is adsb.lol's real, keyless `/v2/lat/{lat}/lon/{lon}/dist/{nm}`
endpoint -- no trimming beyond the two aircraft the live query happened to
return over Sortland/Vesterålen at capture time (`SAS69L`, an Airbus
A320neo, and `NOZ1KV`, a Boeing 737-800). Both are airborne, so this fixture
exercises `flight` trimming (both values are padded with trailing spaces:
`"SAS69L  "`, `"NOZ1KV  "`) and a numeric `alt_baro`, but not the
`alt_baro: "ground"` case -- `provider.test.ts` covers that with a small
hand-built raw object instead, since no aircraft happened to be reporting
from the ground at capture time.

## Synthetic

None yet. `airplaneslive`/`adsbfi` are documented as shape-compatible
community forks of the same underlying format as adsb.lol and are not
independently fixture-tested here -- `provider.test.ts` parses
`adsb-lol-live.json` through the one shared raw schema all three v2
providers use, which is the meaningful test (the schema, not any one
provider's exact byte-for-byte response).
