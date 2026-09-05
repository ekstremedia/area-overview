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

| Entry             | Exercises                                                                                                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MS NORDLYS`      | The ordinary case: full data, inside the test bbox.                                                                                                                                                                        |
| `FISKEBAT SENIOR` | `trueHeading: 511` -- AIS's own "not available" sentinel, must map to `null`, not `511`.                                                                                                                                   |
| `UKJENT LOSBAT`   | `latitude`/`longitude: null` -- can't be placed on the map, must be dropped entirely, not passed through with `lat`/`lng: null`.                                                                                           |
| `COASTAL EXPRESS` | `speedOverGround`/`courseOverGround: null` -- the shared `Ship` schema types these as non-nullable `number`, so a `null` upstream value maps to `0`.                                                                       |
| `OUTSIDE VIEW`    | Inside world bounds but outside the test bbox used in `barentswatch.test.ts` -- must be filtered out by the client-side bbox filter, since the real endpoint returns the whole nationwide array with no filter of its own. |

If real credentials become available later, replace this with a genuine
`GET /v1/latest/combined` capture (trimmed to ~10-20 ships, same convention
as `src/shared/fixtures/README.md`), and update this note.
