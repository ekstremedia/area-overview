# Contributing

## Getting started

```bash
git clone https://github.com/ekstremedia/area-overview.git
cd area-overview
npm ci
cp .env.example .env   # fill in local values
npm run dev
```

## Before opening a pull request

```bash
npm run check   # typecheck, lint, format check, tests
```

CI runs the same command plus a production build, so it's worth matching
locally before pushing.

## Commit messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): summary
```

Common types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`. No ticket
numbers — the summary should stand on its own.

## Pull requests

One logical change per pull request. Keep unrelated cleanups out of a feature
or fix PR; send them separately.
