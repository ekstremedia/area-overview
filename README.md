# area-overview

A reactive vanilla-TypeScript (no framework) live map plus weather, aurora,
tide and camera pages, backed by a small Node/TypeScript backend-for-frontend
(BFF) that proxies a Laravel API. Built as a TypeScript learning vehicle.
Eventually deployed as a Docker Compose stack at `area.nesthus.no`.

See `docs/ARCHITECTURE.md` for how the pieces fit together, `docs/ROADMAP.md`
for the phase plan, and `docs/adr/` for the reasoning behind the main design
decisions.

## Development

```bash
npm ci
cp .env.example .env   # fill in local values
npm run dev             # runs the BFF and the Vite dev server together
```

## Building

```bash
npm run build
```

## Checks

```bash
npm run typecheck
npm run lint
npm run format:check
npm run test
npm run check   # all of the above
```

## Deployment

Runs as a single-service Docker Compose stack, published behind a reverse
proxy at `area.nesthus.no`.

`.env` must exist before the stack can start -- create it with `make init`
(copies `.env.example` to `.env` if one doesn't already exist yet), then
fill in the values yourself, in particular `SETTINGS_PASSWORD` (required,
at least 16 characters). `.env` is never committed and never overwritten by
`make init` once it exists.

```bash
make init            # create .env (first time only), then edit it
docker compose up -d --build
```

This builds the image (frontend via Vite, server compiled with `tsc`),
starts the `app` container bound to `127.0.0.1:8141` only, and persists the
settings store under `./data/`. See the `Makefile` for the rest of the
day-to-day targets (`up`, `down`, `restart`, `deploy`, `logs`, `shell`,
`check`).

The one-time hostname and certificate setup that only a human with DNS/
certbot access can do is in `deploy/manual-steps.md`.
