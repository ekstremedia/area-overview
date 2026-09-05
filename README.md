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

Later phases add a Docker Compose stack for running the BFF and serving the
built frontend, published behind a reverse proxy at `area.nesthus.no`.
