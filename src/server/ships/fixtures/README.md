# Ships (BarentsWatch AIS) fixtures

## Synthetic

`combined-synthetic.json` is hand-written, not captured live: no real
`BARENTSWATCH_CLIENT_ID`/`BARENTSWATCH_CLIENT_SECRET` were available in the
environment this phase was built in (verified via `loadConfig()`, never by
reading `.env`). It models the verified real field shape of
`GET https://live.ais.barentswatch.no/v1/latest/combined`'s
`CombinedSimpleJson` array elements (cross-checked against
`github.com/ilder-as/go-barentswatch-ais` and a blog post with real curl
examples -- see `../barentswatch.ts`'s doc comment), including the edge
cases the mapping/filtering logic needs to handle correctly:

| Entry             | Exercises                                                                                                                                                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MS NORDLYS`      | The ordinary case: full data, inside the test bbox, `navigationalStatus: 0` ("under way using engine").                                                                                                                                                           |
| `FISKEBAT SENIOR` | `trueHeading: 511` -- AIS's own "not available" sentinel, must map to `null`, not `511`. `navigationalStatus: 7` ("fishing").                                                                                                                                     |
| `UKJENT LOSBAT`   | `latitude`/`longitude: null` -- can't be placed on the map, must be dropped entirely, not passed through with `lat`/`lng: null`. `navigationalStatus: 15` ("undefined") for the "unknown" theme.                                                                  |
| `COASTAL EXPRESS` | `speedOverGround`/`courseOverGround: null` -- the shared `Ship` schema types these as non-nullable `number`, so a `null` upstream value maps to `0`. `navigationalStatus: 5` ("moored").                                                                          |
| `OUTSIDE VIEW`    | Inside world bounds but outside the test bbox used in `barentswatch.test.ts` -- must be filtered out by the client-side bbox filter, since the real endpoint returns the whole nationwide array with no filter of its own. `navigationalStatus: 1` ("at anchor"). |

If real credentials become available later, replace this with a genuine
`GET /v1/latest/combined` capture (trimmed to ~10-20 ships, same convention
as `src/shared/fixtures/README.md`), and update this note.

## `navigationalStatus`

Verified as a real, always-present field directly against the live
endpoint (`GET https://live.ais.barentswatch.no/v1/latest/combined`) with
real `BARENTSWATCH_CLIENT_ID`/`BARENTSWATCH_CLIENT_SECRET` credentials, on
2026-09-06 -- not guessed, not inferred from third-party source code like
the rest of this file's field list. It is an integer, the standard ITU-R
M.1371 AIS navigational status enum (0-15), and was present and non-null
across all 4123 real live entries checked at that time. `0` ("under way
using engine") was the plurality (2599 of 4123); other values observed
included `1` (at anchor), `5` (moored), `7` (fishing) and `15` (not
defined), among others. `RawShipSchema` still types it `.nullish()` (see
`../barentswatch.ts`'s doc comment on that field) purely as this schema's
existing defensive convention, not because a null/missing value was ever
actually observed.
