#!/usr/bin/env bash
# Cage's single client (invoked as `cage -- /usr/local/bin/start-kiosk.sh`
# by area-kiosk.service, running as the unprivileged `kiosk` user). Cage is
# the Wayland compositor here; this script is the one thing it wraps --
# cage's own usage model is "one compositor instance, one client command",
# so the launch order is cage-wraps-script, not script-wraps-cage.
#
# Job: wait until the app answers, then `exec` Chromium so this script's
# process *becomes* Chromium. When Chromium exits (crash, forced update,
# whatever), that ends cage's only client, so cage exits too, and
# area-kiosk.service's `Restart=always` relaunches the whole
# cage+start-kiosk.sh+chromium stack together -- including a fresh healthz
# wait. That is deliberately the restart boundary: restarting cage and
# Chromium as one unit is simpler than an inner restart loop here, and the
# plan's "restarts Chromium if it exits" requirement doesn't need anything
# finer-grained than that.
#
# Never put the settings password here, in an env var, on the Chromium
# command line, or in anything this script prints -- it must never appear
# in `ps`, a unit file, or a log line.
set -euo pipefail

HEALTHZ_URL="https://area.nesthus.no/healthz"
APP_URL="https://area.nesthus.no/"
PROFILE_DIR="/home/kiosk/.config/area-kiosk"
RETRY_INTERVAL_SECONDS=5

echo "start-kiosk: waiting for ${HEALTHZ_URL} to answer..."

# A plain retry loop, not `curl --retry`, because `--retry` gives up after
# a fixed count -- this must retry forever, quietly, through both a DNS
# failure and a TLS verification failure (no `-k`: an invalid/incomplete
# certificate must NOT be treated as "up", it must keep retrying exactly
# like a DNS or connection failure does). `--max-time` bounds each attempt
# so a hung connection doesn't stall the loop past the retry interval.
until curl --fail --silent --show-error --max-time 5 "$HEALTHZ_URL" >/dev/null 2>&1; do
    sleep "$RETRY_INTERVAL_SECONDS"
done

echo "start-kiosk: ${HEALTHZ_URL} answered -- launching Chromium."

# --force-device-scale-factor=1: the design is native 1024x600 and already
# sizes its type for that panel. Bump to 1.25 only if the real 7" panel
# reads too small in person (see deploy/kiosk/README.md).
exec chromium \
    --kiosk \
    --noerrdialogs \
    --disable-session-crashed-bubble \
    --disable-infobars \
    --user-data-dir="$PROFILE_DIR" \
    --force-device-scale-factor=1 \
    --ozone-platform=wayland \
    "$APP_URL"
