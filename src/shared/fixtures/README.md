# Fixtures

Recorded upstream responses used by the schema tests in `src/shared/schemas/*.test.ts`.

## Live-captured

Captured 2026-09-05 from the real production upstream at `https://nesthus.no`
(not the local Docker instance at `127.0.0.1:8100`, which has no cameras and
no weather summary yet).

| File                           | Source                     |
| ------------------------------ | -------------------------- |
| `cameras.json`                 | `GET /api/app/cameras`     |
| `weather.json`                 | `GET /api/weather`         |
| `weather-netatmo-offline.json` | `GET /api/weather`         |
| `weather-summary.json`         | `GET /api/weather/summary` |
| `aurora.json`                  | `GET /api/aurora/all`      |
| `tide.json`                    | `GET /api/tide`            |

`weather.json` contains a `netatmo` block from
Terje's own home weather station. The upstream response includes the
station's user-set display name and its module MAC addresses, both of which
are personal/identifying rather than public weather data, so before
committing these fixtures the `netatmo.station_name`, the `NAMain` module's
`name`, and every module `id` (MAC address) were replaced with generic
placeholders (`"Home Station"`, `"Base station"`, `aa:bb:cc:00:00:0N`). All
other fields (temperatures, humidity, timestamps, etc.) are untouched.

`weather-netatmo-offline.json` was captured 2026-09-05 while Terje's home
Netatmo station was genuinely offline: `netatmo` is `null` and
`current.rain` has no `current`/`last_hour`/`last_24h` keys at all (both
real, expected degraded-but-valid upstream states, not malformed data).
There is no `netatmo` block to redact in this one since it's `null`; the
rest of the payload was checked and contains no personal/identifying data
(same public weather fields as the other two).

## Synthetic

`weather-summary-empty.json` is hand-written, not captured live. The
`/api/weather/summary` endpoint can return HTTP 204 with `{"summary": null}`
when no summary has been generated yet, but production currently always has
one, so that state can't be recorded from a live request right now. It
models the shape `WeatherSummarySchema` must also accept.
