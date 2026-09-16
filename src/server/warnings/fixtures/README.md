# Warnings layer fixtures

Hand-authored fixtures standing in for the two keyless upstreams
`/api/warnings` merges: MET Alerts (`api.met.no/weatherapi/metalerts/2.0/current.json`)
and NVE Varsom (`api01.nve.no/hydrology/forecast/avalanche/v6.3.0/api/...`).

| File                                       | Stands in for                                                                    | Used by                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `met-alerts-northern-norway.json`          | MET Alerts' `current.json` (nationwide answer)                                   | `../met-alerts.test.ts`, `../../routes/warnings.test.ts` |
| `nve-regions-northern-norway.json`         | NVE Varsom's `GET /Region` (nationwide roster)                                   | `../regions.test.ts`, `../../routes/warnings.test.ts`    |
| `nve-avalanche-warning-in-season.json`     | `GET /AvalancheWarningByRegion/Detail/...` for a region with an active warning   | `../avalanche.test.ts`, `../../routes/warnings.test.ts`  |
| `nve-avalanche-warning-out-of-season.json` | The same endpoint out of season (`DangerLevel: "0"`, `MainText: "Ikke vurdert"`) | `../avalanche.test.ts`, `../../routes/warnings.test.ts`  |

None of these are wire captures -- unlike `../../aircraft/fixtures/adsb-lol-live.json`,
every byte here is written by hand, the same convention
`../../roads/fixtures/README.md` and `../../transit/fixtures/README.md`
follow. The **shapes and field names** are not guesses, though: they follow
this phase's own ground-truth live probing of both APIs (2026-09-16),
documented in the plan this phase implements. One field is a documented
assumption rather than a probed fact -- see "Field names" below.

## The area these fixtures share

Every region and every MET feature here sits in or near the Vesterålen/
Ofoten area this app already uses for its other fixtures (`../../transit/fixtures/README.md`,
`../../roads/fixtures/README.md`), so the same test bbox
(`14.5,68.35,16.5,69.05`) is a useful default across all of `../../routes/warnings.test.ts`'s
tests, not just the transit/roads ones it was originally chosen for.

## `nve-regions-northern-norway.json` -- four regions, not all 46

NVE's real `/Region` answer carries all ~46 forecast regions with full
polygons; this fixture trims that to four simple rectangles, which is
enough to exercise the bbox-intersection logic without hand-authoring a
realistic coastline:

- **Vesterålen** (`3003`) and **Ofoten** (`3004`) both overlap the test
  bbox above (`3004`'s rectangle spans `15.40..17.00` longitude, and the
  test bbox reaches to `16.5`) -- a bbox request against them is the "two
  regions" case.
- **Nord-Troms** (`3010`) and **Salten** (`3005`) sit well outside the test
  bbox (north and south of it respectively) -- included so "a bbox
  touching none" and "the regions list contains regions this viewport
  doesn't touch" are both exercised by the same fixture.

Each `Polygon` is a single-entry array (one ring) -- `regions.ts`'s
"more than one ring, pick the longest" handling is a defensive
simplification for a shape never observed live, not something this
fixture demonstrates.

## `nve-avalanche-warning-*.json`

- **in-season**: region `3003` (Vesterålen), `DangerLevel: "3"`
  ("Betydelig"), a `MainText` that would never be shown to a visitor (see
  `avalanche.ts`'s header -- this app never surfaces the text, only
  compares it against `"Ikke vurdert"`) but is realistic in shape.
- **out-of-season**: region `3004` (Ofoten), `DangerLevel: "0"` AND
  `MainText: "Ikke vurdert"` together, matching what NVE was observed to
  send out of season -- both signals present at once, even though
  `mapAvalancheWarning` treats either alone as sufficient.

## `met-alerts-northern-norway.json` -- five features

- **`...0.1`** gale, `riskMatrixColor: "Yellow"`, inside the test bbox.
- **`...0.2`** heavy snow, `riskMatrixColor: "Orange"`, inside the bbox,
  `area: null` and `consequences: null` -- MET may omit either.
- **`...0.3`** ice, `riskMatrixColor: "Red"`, inside the bbox, no
  `eventEndingTime` (`endsAt` must map to `null`, not fail).
- **`...0.4`** a storm surge around Oslo (`lng ~10.5-10.9, lat ~59.8-60.0`)
  -- geographically nowhere near the test bbox, so it must never appear in
  a response for it regardless of its own `riskMatrixColor`. This is the
  "a polygon that does not intersect the bbox" case.
- **`...0.5`** wind, `riskMatrixColor: null` -- the one feature that must
  fall back to parsing the colour out of `awareness_level`'s
  semicolon-joined triple (`"2; yellow; Moderate"` -> `"yellow"`), inside
  the bbox.

Together `...0.1`/`...0.2`/`...0.3` are the "three-colour spread" the plan
asks for (yellow/orange/red via `riskMatrixColor` directly), `...0.4` is
the exclusion case, and `...0.5` is the triple-splitting fallback case.

## `title`'s embedded start time

MET Alerts has no dedicated start-time field at all -- confirmed live
against 7 real alerts on 2026-09-16, all carrying `eventEndingTime` but
nothing else time-related. The only place a start time appears is
`title`, a free-text summary whose last two comma-separated segments are
always the start and end ISO timestamps (the end one matching
`eventEndingTime` exactly in every alert probed). Every feature's `title`
here embeds a start time in that position -- `...0.3`'s deliberately omits
an end time (mirroring a real alert with no `eventEndingTime`) to pin that
`extractStartsAt` still finds the start when only one timestamp is
present.
