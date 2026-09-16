# Entur (Transit layer) fixtures

One GraphQL response standing in for the keyless realtime vehicles API at
`https://api.entur.io/realtime/v1/vehicles/graphql`.

| File                             | Stands in for                    | Used by                                            |
| -------------------------------- | -------------------------------- | -------------------------------------------------- |
| `entur-vehicles-vesteralen.json` | `{ vehicles(boundingBox: ...) }` | `../entur.test.ts`, `../../routes/transit.test.ts` |

## Hand-authored values, one verbatim record

Unlike `../../aircraft/fixtures/adsb-lol-live.json`, this is not a raw
capture. One record (`3390101274`) is copied byte-for-byte from a real
response probed live on 2026-09-15 -- see this repo's Phase B plan for the
`curl`-equivalent query. The rest are hand-written to exercise this app's
own handling, following the same convention as
`../../roads/fixtures/README.md`.

Field names are not guesses: `Line.lineName` (not `name`) and
`Operator.operatorRef` (not `name`) were confirmed against the live schema
-- asking for either wrong name fails the _whole_ query with a
`FieldUndefined` error and `data: null`, which is why `entur.ts` treats a
top-level `errors` array as a fetch failure rather than an empty result.

## What each record is for

- **`3390101274`** the real record: a bus, `delay: 201` (running late),
  `speed: null` (true on every record probed), `operatorRef` a real,
  non-empty value.
- **`3390101999`** a ferry with a **negative delay** (`-90`, running
  early) and an **empty-string `operatorRef`** -- real ferry records
  carry this, and it must be passed through as `""`, not converted to
  `null`. Its `line` object is present but both `publicCode` and
  `lineName` are `null`.
- **`3390102500`** mode `RAIL` -- not bus or ferry, dropped by the mode
  filter. This is the filter working as designed, so it must not be
  counted as a discard.
- **`3390090001`** a bus whose `lastUpdated` is from early that same
  morning -- well past any reasonable `maxAgeMinutes` window relative to
  the other records' clock. Stands in for what live probing found: Entur
  keeps a vehicle in the feed until its `expiration`, hours after its
  last real fix, so without the age filter a parked bus would be shown
  as live all night.
- **`3390103000`** a bus with **no `line` and no `operator` object at
  all** (as opposed to `3390101999`'s empty-string case) -- `line`,
  `publicCode` and `operatorRef` must all map to `null`, and
  `origin`/`destination` are explicitly `null` too.

The tests that care about freshness fix the clock (`vi.setSystemTime`) at
a moment shortly after the fixture's freshest timestamps, the same way
`routes/road-situations.test.ts`'s clock test does -- this data does not
stay fresh relative to the real clock, unlike the roads fixture's
open-ended situations.
