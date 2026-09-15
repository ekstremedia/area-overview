# area-overview

A kiosk dashboard for one stretch of coast: a live map of the ships and
aircraft passing through it and of what is happening on its roads, plus
weather, aurora and tide pages that cycle on their own on a wall display.

The frontend is vanilla TypeScript -- no framework, its own small reactive
primitives -- built with Vite, with Leaflet for the map. Behind it sits a
Node/TypeScript backend-for-frontend on Fastify. It proxies exactly one
**upstream** -- the `nesthus.no` Laravel API, which serves weather, tide,
aurora and the cameras -- and calls three **providers** directly for the
live data upstream has nothing for: BarentsWatch (AIS), an ADS-B aggregator
(aircraft) and Statens vegvesen (road notices and road cameras). It holds
the API credentials, caches the responses and validates every payload with
Zod before the browser sees it.

A live instance runs at [area.nesthus.no](https://area.nesthus.no/).

See `docs/ARCHITECTURE.md` for how the pieces fit together, `docs/ROADMAP.md`
for the phase plan, and `docs/adr/` for the reasoning behind the main design
decisions.

## Requirements

- Node 22 or newer, and npm.
- Optional provider credentials, all set in `.env`. Without them the app
  runs and those pages simply report that they are not configured:
    - `BARENTSWATCH_CLIENT_ID` / `_SECRET` -- AIS ship positions.
    - `OPENSKY_CLIENT_ID` / `_SECRET` -- aircraft, if `ADSB_PROVIDER=opensky`;
      the default `adsblol` needs no credentials.
    - `CARTO_API_KEY` -- unwatermarked dark basemap tiles.
    - Statens vegvesen's road data is keyless; nothing to set.
- `SETTINGS_PASSWORD` (at least 16 characters) is required -- the BFF
  refuses to start without it. It is the one passphrase that authorises
  edits from the settings page; reading is public.

## Setup

```bash
npm ci
cp .env.example .env   # then fill in the values
```

`.env` is never committed. Every key in `.env.example` is documented there.

## Running

```bash
npm run dev     # the BFF and the Vite dev server together
```

The BFF listens on `127.0.0.1:8141` (`PORT`/`HOST` in `.env`) and Vite
proxies `/api` to it. It must never bind `0.0.0.0`: expose it through a
reverse proxy instead.

```bash
npm run build   # frontend via Vite, server via tsc, both into dist/
npm start       # serve the built app from the BFF
```

## Checks

```bash
npm run check   # typecheck, lint, format:check, test
```

Each stage is also available on its own (`npm run typecheck`, `lint`,
`format:check`, `test`, plus `test:watch`, `lint:fix`, `format`).

## Deployment

The app ships as a single-service Docker Compose stack: one image containing
the built frontend and the BFF that serves it, published on `127.0.0.1:8141`
for a reverse proxy to terminate TLS in front of.

```bash
make init                    # create .env if absent, then fill it in
docker compose up -d --build
```

Settings persist in `./data/`. `make check` verifies the published port is
loopback-only and the container is healthy; `make deploy` pulls, rebuilds and
brings the stack up. The `Makefile` has the rest (`build`, `up`, `down`,
`restart`, `logs`, `shell`).

Hostname, DNS and certificate setup -- the parts that need a human -- are in
`deploy/manual-steps.md`.

## Licence and attribution

MIT.

The road notices, road cameras and traffic-sign artwork on the map come
from Statens vegvesen under NLOD, which requires attribution:

> Inneholder data under norsk lisens for offentlige data (NLOD)
> tilgjengeliggjort av Statens vegvesen.

The sign faces are vendored in `src/web/pages/map/signs/`; that
directory's `README.md` records where they came from, what was changed
and why they are only ever drawn small. The map footer carries the short
form, `Data: Statens vegvesen`.
