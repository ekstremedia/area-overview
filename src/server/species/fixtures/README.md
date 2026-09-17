# GBIF occurrence search (Species layer) fixtures

One `GET /v1/occurrence/search` response standing in for GBIF's keyless
occurrence search API.

| File                                     | Stands in for               | Used by                                                  |
| ---------------------------------------- | --------------------------- | -------------------------------------------------------- |
| `gbif-occurrence-search-vesteralen.json` | `GET /v1/occurrence/search` | `../occurrences.test.ts`, `../../routes/species.test.ts` |

## Hand-authored, following `../../transit/fixtures/README.md`'s precedent

Every record is hand-written to exercise this app's own handling, rather
than a raw capture -- but field shapes and values (in particular the
licence legalcode URLs and the presence of `recordedBy` on a real-looking
record) were confirmed against a live GBIF response probed 2026-09-17.
`count: 7` intentionally equals `results.length`, so this fixture alone
never triggers `truncated: true` -- that path is exercised with a
synthetically generated record list built directly inside
`occurrences.test.ts`, not a static fixture.

## What each record is for

- **`1001`/`1002`** two records of the same species (`speciesKey: 100`,
  _Cyanistes caeruleus_) within ~110m of each other -- they group into one
  sighting. Together they exercise:
    - **the privacy requirement**: `1001` carries `recordedBy: "Sonja
Stavem"` -- a real-looking private name, exactly the shape GBIF sends
      live -- specifically so `routes/species.test.ts` can assert it never
      appears anywhere in the serialised response body, even though this
      fixture contains it.
    - **newest-wins for group scalars**: `1002` is dated later
      (`2026-09-12` vs `2026-09-10`) and has `vernacularName: null` --
      the group's `vernacularName` must come out `null`, not `1001`'s
      `"Blåmeis"`, proving the newest record wins even when that means
      losing a non-null value an older record had.
    - **the licence-conflict rule**: `1001` is `.../by/4.0/legalcode`
      (CC BY), `1002` is `.../by-nc/4.0/legalcode` (CC BY-NC) -- the more
      restrictive of the two must win the group's one `license` field.
    - **`individualCount` summing**: `2 + 3 = 5`.
    - **`coordinateUncertaintyMeters` fallback**: `1002` (the newest) has
      none; the group must still report `1001`'s `50`, proving the search
      looks past the newest record when it is silent on this field.
    - Also carries `media` and `basisOfRecord` (non-goal fields, never part
      of the shared schema) and `recordedBy`, to prove a hypothetical naive
      passthrough would be caught, not merely that a careful allow-list
      doesn't leak by construction.
- **`1003`** _Lynx lynx_, no `eventDate` at all -- discarded
  (`missingEventDate`), mirroring how `transit/vehicles.ts` discards a
  record with no `lastUpdated`.
- **`1004`** _Vulpes vulpes_, no `speciesKey` at all -- discarded
  (`missingSpeciesKey`): it cannot be grouped meaningfully.
- **`1005`** _Amanita muscaria_, `kingdom: "Fungi"` and **no `class`
  field at all** -- exercises the class-absent fallback (`class` becomes
  `"Fungi"`, this record's own `kingdom`). Also has no `individualCount`
  at all, exercising the "no record in the group reported one" `null`
  case (it is the only record in its group). Its licence is the
  `publicdomain/zero` CC0 URL, the least restrictive rank. Also carries
  `recordedBy: "Kari Fjellheim"` -- a second, real-looking private name,
  deliberately placed on the NEWEST (and only) record of its own group,
  unlike `1001`'s `"Sonja Stavem"` which sits on the OLDER of two records
  in a group the newer record supersedes for every other field. This is
  the stronger privacy assertion: it would catch a hypothetical "spread
  the newest record's raw fields" bug that `1001`'s placement alone could
  not.
- **`1006`** the same species as `1001`/`1002` (`speciesKey: 100`) but far
  away (`69.999,16.5`) -- proves grouping is per-position, not merely
  per-species: it must NOT join `1001`/`1002`'s group.
- **`1007`** _Rangifer tarandus_, no `decimalLatitude`/`decimalLongitude`
  at all -- discarded (`attributes`): a record this app cannot place has
  no coordinate to group or show at all.
