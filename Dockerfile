# syntax=docker/dockerfile:1
#
# Multi-stage build. The `build` stage has the full devDependencies (tsx,
# vite, typescript, vitest, ...) needed to compile the frontend and the
# server; the final stage installs production dependencies only and never
# sees a devDependency or a line of TypeScript -- it runs the compiled
# output from `dist/`, matching house style ("no dev dependencies in the
# production image").
#
# Pinned to an exact node:22.x.y-alpine tag, never `node:22-alpine` or
# `node:latest`, so a rebuild months from now can't silently pick up a
# different Node minor/patch (or a different Alpine base) than the one
# this image was tested against.

FROM node:22.23.2-alpine AS build
WORKDIR /app

# Install with the lockfile before copying the rest of the source so this
# layer only invalidates when dependencies actually change.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Produces dist/web (Vite) and dist/server + dist/shared (tsc), see
# package.json's build/build:web/build:server scripts.
RUN npm run build


FROM node:22.23.2-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
# --ignore-scripts: the only script here is `prepare` (simple-git-hooks, a
# devDependency deliberately absent from this stage) -- there is no git repo
# and no hook to install in a production image, and none of the production
# dependencies need a native postinstall step.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/dist ./dist

# The image's built-in `node` user is uid 1000, which is also `terje`'s uid
# on the host this runs on -- so the bind-mounted ./data directory (see
# docker-compose.yml) is writable by the container with no chown dance on
# either side.
USER node

# `GET /healthz` is a fast liveness/readiness probe (see
# src/server/routes/healthz.ts) that never touches an upstream cache.
# wget is busybox's, already present in node:*-alpine -- no need to install
# curl just for this.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-8141}/healthz" || exit 1

CMD ["node", "dist/server/index.js"]
