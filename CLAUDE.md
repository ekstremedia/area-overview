# area-overview

## Stack

- Frontend: vanilla TypeScript (no framework), built with Vite, mapping via
  Leaflet.
- Backend-for-frontend (BFF): Node/TypeScript on Fastify.
- Validation/schemas: Zod, shared between server and frontend where the data
  contract is shared.

## Hard constraints

- **The BFF must always bind `127.0.0.1`, never `0.0.0.0`, on the host.** It
  is published to the outside world only through a reverse proxy or an
  explicit port mapping controlled at deploy time, never by listening on all
  interfaces itself.
- The BFF listens on port **8141** in development and in the reference
  deployment.

## Conventions

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`type(scope): summary`), types include `feat`, `fix`, `docs`, `chore`,
  `refactor`, `test`.
- One pull request per roadmap phase (see `docs/ROADMAP.md`); avoid mixing
  unrelated changes into a single PR.
- Run `npm run check` before opening a PR; CI runs the same command.
- Two real obstacles hit stacking multiple phase PRs (phases 2-10): squash-
  merging one breaks git ancestry for any branch still stacked on its
  pre-squash commits (retargeting then shows bogus conflicts -- merge in
  order, or do a small sync PR to fix ancestry after); and CodeRabbit does
  not auto-review PRs over ~150 changed files or targeting a non-default
  branch, so a large combined PR can silently get zero review coverage.

## Where to look

- `docs/ARCHITECTURE.md` — how the pieces fit together.
- `docs/ROADMAP.md` — the phase plan.
- `docs/adr/` — decisions and their rationale.
