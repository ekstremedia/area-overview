#!/usr/bin/env bash
# One-time-ish production install for area-overview. Idempotent -- safe to
# re-run. Never uses sudo: everything it touches is owned by the user
# running it (this repo checkout, ~/bin/dev-proxy-sync's output file is
# root:terje 0664 and writable without sudo -- see that script's own
# comments).
#
# Run this from the repo root:
#   bash deploy/install.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> Ensuring data/ exists"
mkdir -p data

echo "==> Running 'make init' (creates .env from .env.example if missing)"
make init

if [ ! -f .env ]; then
    echo "✗ .env still doesn't exist after 'make init' -- aborting." >&2
    exit 1
fi

# Never generated here -- Terje must choose and type his own, since it
# needs to be typeable on a touchscreen later. This only checks the value
# he already put in .env.
SETTINGS_PASSWORD_VALUE="$(sed -n 's/^SETTINGS_PASSWORD=//p' .env | tail -1)"

if [ -z "$SETTINGS_PASSWORD_VALUE" ] || [ "${#SETTINGS_PASSWORD_VALUE}" -lt 16 ]; then
    echo "" >&2
    echo "✗ SETTINGS_PASSWORD in .env is missing or too short." >&2
    echo "  It must be a passphrase of at least 16 characters -- the app" >&2
    echo "  itself won't boot without one. Edit .env and set it yourself" >&2
    echo "  (four random words is a good pattern; it needs to be typeable" >&2
    echo "  on a touchscreen later), then re-run this script." >&2
    echo "" >&2
    exit 1
fi

echo "==> Restricting .env permissions"
chmod 600 .env

echo "==> Deploying (build + up)"
make deploy

echo "==> Syncing the Apache dev-project port map"
~/bin/dev-proxy-sync

echo ""
echo "==> Install steps this script can do are done."
echo "    Remaining manual steps (DNS + certificate) are in:"
echo "      deploy/manual-steps.md"
echo ""
