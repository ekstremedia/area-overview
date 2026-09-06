#!/usr/bin/env bash
# Idempotent install of the area-overview kiosk onto pi5ai. Run as root, on
# the Pi's own terminal (or an SSH session that has interactive sudo --
# this is a separate machine from the NUC this repo is normally deployed
# from, and this script has no access to the Pi to run itself).
#
#   sudo ./install-kiosk.sh <nuc-lan-ip>
#
# <nuc-lan-ip> is the NUC's LAN IP address (e.g. 192.168.0.2), written into
# /etc/hosts so the Pi reaches area.nesthus.no directly instead of via the
# router hairpin. Never hardcode a real IP in this script -- this repo is
# public.
#
# What this script does NOT do, ever: touch pi5ai's Apache or gunicorn
# config, `pi`'s home directory, session or lightdm config, or any
# firewall. It also never enables or starts area-kiosk.service -- it only
# installs the unit file and reloads the systemd daemon, so a human
# confirms the /dev/tty8 preflight (see README.md) before the kiosk takes
# over a VT.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "error: run this script as root (sudo ./install-kiosk.sh <nuc-lan-ip>)" >&2
    exit 1
fi

NUC_IP="${1:-}"
if [ -z "$NUC_IP" ]; then
    echo "usage: $0 <nuc-lan-ip>" >&2
    echo "  e.g. sudo ./install-kiosk.sh 192.168.0.2" >&2
    exit 1
fi

# Validate <nuc-lan-ip> looks like an IPv4 address before it ever reaches
# /etc/hosts -- four dot-separated octets, each 0-255.
validate_ipv4() {
    local ip="$1"
    if [[ ! "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        return 1
    fi
    local octet
    local -a octets
    IFS='.' read -r -a octets <<<"$ip"
    for octet in "${octets[@]}"; do
        # Force base 10: a leading zero (e.g. "08") would otherwise be
        # read as an invalid octal literal by bash arithmetic.
        if ((10#$octet > 255)); then
            return 1
        fi
    done
    return 0
}

if ! validate_ipv4 "$NUC_IP"; then
    echo "error: '$NUC_IP' does not look like an IPv4 address" >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Track what actually changed vs. what was already in place, for the
# summary at the end.
CHANGES=()
SKIPPED=()

echo "==> Checking for the 'kiosk' system user"
if id kiosk >/dev/null 2>&1; then
    SKIPPED+=("user 'kiosk' already exists")
else
    useradd --system --create-home --home-dir /home/kiosk --shell /usr/sbin/nologin kiosk
    CHANGES+=("created system user 'kiosk' (home /home/kiosk, no shell login)")
fi

# Belt and braces: a --system user already has a locked password field by
# default, but make it explicit and idempotent rather than relying on that.
passwd -l kiosk >/dev/null 2>&1 || true

echo "==> Adding 'kiosk' to render/video groups (whichever exist here)"
for group in render video; do
    if ! getent group "$group" >/dev/null 2>&1; then
        SKIPPED+=("group '$group' does not exist on this system -- not added")
        continue
    fi
    if id -nG kiosk | tr ' ' '\n' | grep -qx "$group"; then
        SKIPPED+=("'kiosk' already in group '$group'")
    else
        usermod -aG "$group" kiosk
        CHANGES+=("added 'kiosk' to group '$group'")
    fi
done

echo "==> Checking for cage, chromium and curl"
PACKAGES_NEEDED=()
for pkg in cage chromium curl; do
    if dpkg -s "$pkg" >/dev/null 2>&1; then
        SKIPPED+=("package '$pkg' already installed")
    else
        PACKAGES_NEEDED+=("$pkg")
    fi
done
if [ "${#PACKAGES_NEEDED[@]}" -gt 0 ]; then
    apt-get update
    apt-get install -y "${PACKAGES_NEEDED[@]}"
    CHANGES+=("installed package(s): ${PACKAGES_NEEDED[*]}")
fi

echo "==> Checking /etc/hosts for area.nesthus.no"
HOSTS_LINE="$NUC_IP area.nesthus.no"
EXISTING_HOSTS_LINE="$(grep -E '[[:space:]]area\.nesthus\.no([[:space:]]|$)' /etc/hosts || true)"
if [ -z "$EXISTING_HOSTS_LINE" ]; then
    printf '%s\n' "$HOSTS_LINE" >>/etc/hosts
    CHANGES+=("added '$HOSTS_LINE' to /etc/hosts")
elif [ "$EXISTING_HOSTS_LINE" = "$HOSTS_LINE" ]; then
    SKIPPED+=("/etc/hosts already has '$HOSTS_LINE'")
else
    echo "warning: /etc/hosts already has an area.nesthus.no line that does not match:" >&2
    echo "  existing: $EXISTING_HOSTS_LINE" >&2
    echo "  wanted:   $HOSTS_LINE" >&2
    echo "  not touching it automatically -- edit /etc/hosts by hand if this is stale." >&2
    SKIPPED+=("/etc/hosts area.nesthus.no line left as-is (mismatch -- see warning above)")
fi

echo "==> Installing the Chromium managed policy"
POLICY_DEST=/etc/chromium/policies/managed/area-kiosk.json
mkdir -p /etc/chromium/policies/managed
if [ -f "$POLICY_DEST" ] && cmp -s "$SCRIPT_DIR/area-kiosk.json" "$POLICY_DEST"; then
    SKIPPED+=("$POLICY_DEST already up to date")
else
    install -m 0644 "$SCRIPT_DIR/area-kiosk.json" "$POLICY_DEST"
    CHANGES+=("installed $POLICY_DEST")
fi

echo "==> Installing start-kiosk.sh"
START_DEST=/usr/local/bin/start-kiosk.sh
if [ -f "$START_DEST" ] && cmp -s "$SCRIPT_DIR/start-kiosk.sh" "$START_DEST"; then
    SKIPPED+=("$START_DEST already up to date")
else
    install -m 0755 -o root -g root "$SCRIPT_DIR/start-kiosk.sh" "$START_DEST"
    CHANGES+=("installed $START_DEST (owned by root, executable)")
fi

echo "==> Installing area-kiosk.service"
SERVICE_DEST=/etc/systemd/system/area-kiosk.service
if [ -f "$SERVICE_DEST" ] && cmp -s "$SCRIPT_DIR/area-kiosk.service" "$SERVICE_DEST"; then
    SKIPPED+=("$SERVICE_DEST already up to date")
else
    install -m 0644 "$SCRIPT_DIR/area-kiosk.service" "$SERVICE_DEST"
    CHANGES+=("installed $SERVICE_DEST")
fi

echo "==> Installing udev rule to ignore HDMI-CEC phantom pointer devices"
UDEV_RULE_DEST=/etc/udev/rules.d/99-kiosk-ignore-cec.rules
mkdir -p /etc/udev/rules.d
if [ -f "$UDEV_RULE_DEST" ] && cmp -s "$SCRIPT_DIR/99-kiosk-ignore-cec.rules" "$UDEV_RULE_DEST"; then
    SKIPPED+=("$UDEV_RULE_DEST already up to date")
else
    install -m 0644 "$SCRIPT_DIR/99-kiosk-ignore-cec.rules" "$UDEV_RULE_DEST"
    CHANGES+=("installed $UDEV_RULE_DEST")
fi

# Always (re-)activate, including after a partial previous run that wrote
# the rule file but didn't finish reloading/triggering udev. libinput reads
# LIBINPUT_IGNORE_DEVICE at device-add time, so this does not retroactively
# affect a compositor that is already running (e.g. pi's own desktop session
# on VT7 keeps its phantom pointer until it restarts) -- but it does mean
# the kiosk gets the correct behaviour on its first start, with no reboot
# needed.
udevadm control --reload-rules
udevadm trigger --subsystem-match=input

systemctl daemon-reload

echo ""
echo "==> Done. Changes made:"
if [ "${#CHANGES[@]}" -eq 0 ]; then
    echo "  (none -- everything was already in place)"
else
    for c in "${CHANGES[@]}"; do
        echo "  - $c"
    done
fi

echo ""
echo "==> Already in place / skipped:"
for s in "${SKIPPED[@]}"; do
    echo "  - $s"
done

echo ""
echo "==> NOT done by this script, on purpose:"
echo "  - area-kiosk.service was installed but NOT enabled or started."
echo "    First confirm /dev/tty8 is free (see the preflight check in"
echo "    deploy/kiosk/README.md), then enable and start it yourself:"
echo "      sudo systemctl enable --now area-kiosk"
echo "      sudo systemctl status area-kiosk"
echo "      journalctl -u area-kiosk -f"
