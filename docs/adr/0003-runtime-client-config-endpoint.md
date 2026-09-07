# 0003: A runtime endpoint for client-visible config, not a build-time env var

## Context

Some config values are fine for the browser to see (rate-limited or
domain-restricted tokens, e.g. CARTO's basemap API key) but still live in
`.env` alongside real secrets. The obvious-looking option -- have Vite embed
the value into the built bundle via `import.meta.env`/`define`, sourced from
`process.env` at build time -- does not work in this app's deployment.

This app's Docker build is multi-stage: `docker compose build` runs `npm run
build` in a stage that has no access to the runtime `.env` file at all.
`docker-compose.yml`'s `env_file: .env` only populates the _running
container's_ process environment, not the `docker compose build` step. A
Vite build-time value sourced from `process.env.CARTO_API_KEY` would
silently bake in an empty string in every production image, with no error
anywhere -- the build succeeds, the app boots, and the feature it configures
just quietly doesn't work.

## Decision

Expose this kind of value through a small runtime BFF route instead (e.g.
`GET /api/map-config`), which the frontend fetches once. The value never
touches the build; it's read from `process.env` the same way any other
server config is, at the point something actually asks for it.

The contract such a route should follow, using `GET /api/map-config` as the
concrete example (`src/server/routes/map-config.ts`): unauthenticated (this
is public-by-design data, not a write surface), always `200`, and the value
is **optional** at the server-config level -- `cartoApiKey: z.string().default('')`
in `src/server/config.ts`, never required to boot -- so "unset" is
represented as an empty string in the response body (`{ "cartoApiKey": "" }`),
never a missing key, a different status code, or `null`. The frontend
(`MapPage.ts`) treats that empty string the same way it treats a failed
fetch: a graceful fallback, not an error.

## Consequences

- Works identically in dev and prod, with no build-time/run-time env
  mismatch to reason about.
- The frontend needs one extra fetch (and a documented graceful fallback for
  when it's empty/unset) instead of a value that's simply always present in
  the bundle.
- **This is only for values that are fine to be public.** It is the opposite
  of how this app treats real secrets: BarentsWatch AIS credentials (ADR 0002) are never exposed to the browser in any form, proxied or otherwise.
  A value reaching this kind of endpoint is a deliberate choice that
  exposing it is acceptable, not a default.
