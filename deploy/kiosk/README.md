# Pi kiosk (pi5ai) -- Phase 11

Turns pi5ai's attached 7" panel into a full-screen, unattended kiosk
showing `https://area.nesthus.no/`, without touching pi5ai's existing day
job (Apache + gunicorn/Flask OCR service on the same box) or its existing
`pi` desktop session.

**Status: scripts are authored and validated locally (`bash -n`, JSON
parse, `systemd-analyze verify` -- `shellcheck` was not available on the
authoring machine and was skipped rather than installed) but have NOT been
run on the real Pi yet.** A separate session with interactive `sudo` on
pi5ai runs `install-kiosk.sh` and reports back before this is considered
done.

## What was found on the real hardware (2026-09-06)

- Raspberry Pi OS **Trixie, desktop image** (`systemctl get-default` ->
  `graphical.target`). The Wayland compositor for the existing desktop
  session is **labwc**.
- `lightdm` already has `autologin-user=pi`, `autologin-session=rpd-labwc`
  on **tty1**. That `pi` session runs `rpi-connectd`/`wayvnc` -- Terje's
  remote screen access to this Pi for unrelated work. **This must keep
  working.**
- Because of that, the kiosk does **not** switch lightdm's autologin user
  and does **not** add a labwc autostart entry to the `pi`/`kiosk` desktop
  session. Instead: **`cage` on its own, separate VT**, started by a
  systemd _system_ unit (`area-kiosk.service`) running as the `kiosk`
  user. This coexists with the `pi`/lightdm session on tty1 rather than
  replacing it.
- `chromium` is at `/usr/bin/chromium` (there is no `chromium-browser` on
  this image). `cage` is not installed yet but is available
  (`apt install cage`, candidate `0.2.0-2+rpt1+b1`).
- Panel: **HDMI-A-2** (confirmed via `wlr-randr`: `HDMI-A-2 "Mediatrix
Peripherals Inc MPI7002"`). **Not HDMI-A-1** -- that port is flaky on
  this board; nothing in these scripts references it.
- Native/preferred mode is **1024x600@60.044Hz**, already the active mode
  via EDID autodetect. No `/boot/firmware/config.txt` HDMI override block
  is needed.
- `free -m` baseline **before** the kiosk: 6754 MB available of 8058 MB
  total. A Chromium kiosk tab with one canvas map is ~300-600 MB, so there
  is plenty of headroom; re-measure after the kiosk is running and record
  the number here.
- `ddcutil` hardware-brightness testing is being done separately by Terje
  and isn't gated on anything here; the existing software brightness
  overlay (from an earlier phase) remains the real mechanism regardless of
  what `ddcutil detect` says.
- `--force-device-scale-factor=1` is the starting value in
  `start-kiosk.sh` -- the design is native 1024x600 and already sizes its
  type for a wall. Only bump to `1.25` if it reads too small on the real
  panel, and update `start-kiosk.sh` (and this line) if you do.

## Tile hosts allowed through the Chromium policy

Checked directly in `src/web/pages/map/tiles.ts` (the only file allowed to
reference a tile URL) rather than assumed:

- `basemaps.cartocdn.com` (dark theme, CARTO `dark_all`, `{s}` subdomain
  placeholder -- Leaflet's default subdomains are `a`/`b`/`c`, all covered
  by the leading-dot policy entry `.basemaps.cartocdn.com`)
- `tile.openstreetmap.org` (light theme)

`src/web/index.html` self-hosts its one font (`Source Serif 4`, woff2, no
external font CDN), so no font host needed in the policy. No other
external host is fetched from `src/web` -- everything else (weather, AIS,
aurora, etc.) is server-proxied through the BFF at `area.nesthus.no`
itself.

## One judgment call worth flagging: `IncognitoModeAvailability`

Chromium's managed-policy schema defines `IncognitoModeAvailability` as an
**integer enum** (`0` = Enabled, `1` = Disabled, `2` = Forced), not a
string. `area-kiosk.json` uses the integer `1`. A string value there would
most likely be silently ignored by Chromium's policy parser, defeating the
point of setting it, so this was corrected to the schema's actual type
rather than shipped as a string that looks right but does nothing.

## Running it

From a checkout of this repo on pi5ai itself (or copied over), as root,
with interactive `sudo`:

```bash
sudo ./deploy/kiosk/install-kiosk.sh <nuc-lan-ip>
```

Replace `<nuc-lan-ip>` with the NUC's real LAN IP (this repo is public, so
no real IP is committed anywhere in these files). The script:

- creates the `kiosk` system user (no login password, home
  `/home/kiosk`, added to whichever of `render`/`video`/`input` groups
  actually exist on this system),
- installs `cage` and `chromium` if missing,
- adds `<nuc-lan-ip> area.nesthus.no` to `/etc/hosts` if not already
  present (skips the router hairpin; the certificate is valid for the
  name either way, so this is an optimisation, not a correctness fix),
- installs the Chromium managed policy to
  `/etc/chromium/policies/managed/area-kiosk.json`,
- installs `start-kiosk.sh` to `/usr/local/bin/start-kiosk.sh` (owned by
  `kiosk`, executable) -- kept out of `/home/kiosk` deliberately, so that
  directory holds only the Chromium profile,
- installs `area-kiosk.service` to `/etc/systemd/system/`, runs
  `systemctl daemon-reload`, and `systemctl enable`s it,
- prints a summary of what changed vs. what was already in place.

It never touches Apache, gunicorn, `pi`'s home/session/lightdm config, or
any firewall rule, on the Pi or the NUC.

**It deliberately does not start the service.** Before starting it:

1. **Confirm `tty2` is actually free.** `area-kiosk.service` claims
   `/dev/tty2` for cage; it was chosen because `pi`/lightdm already own
   tty1, but this was not confirmed from a live session on the Pi. Check
   `ls /dev/tty2`, `who`, and whether anything (a getty, another session)
   is already attached to it before enabling. If it's not free, change
   `TTYPath=` in `area-kiosk.service` (and the matching
   `Conflicts=getty@<ttyN>.service` line) to a VT that is, then re-run
   `install-kiosk.sh` so the updated unit gets installed.
2. Start it and watch it come up:

    ```bash
    sudo systemctl start area-kiosk
    sudo systemctl status area-kiosk
    journalctl -u area-kiosk -f
    ```

3. Confirm pi5ai's existing services are unaffected:

    ```bash
    free -m                    # compare against the 6754 MB baseline above
    curl -fsS http://127.0.0.1/        # Apache landing page, unchanged
    curl -fsS http://127.0.0.1/docs/   # Flask OCR service, unchanged
    ```

## How the pieces fit together

- `area-kiosk.service` is a systemd **system** unit running as `User=kiosk`
  with `PAMName=login`, bound to a specific VT (`TTYPath=/dev/tty2`) via
  the standard "cage as a systemd service on its own tty" pattern (see
  cage's own wiki, "Starting cage on a tty with systemd"). `Restart=always`
  restarts the whole thing -- cage and its client together -- if either
  exits.
- Its `ExecStart` is `cage -- /usr/local/bin/start-kiosk.sh`. Cage wraps a
  single client command; that client is `start-kiosk.sh`, not the other
  way around.
- `start-kiosk.sh` waits for `https://area.nesthus.no/healthz` to answer
  (a plain `curl` retry loop, 5 s interval, no `-k`, no giving up -- this
  handles a DNS failure, a connection refusal, and an incomplete/invalid
  TLS certificate identically, all as "not up yet, keep waiting"), then
  `exec`s Chromium so the script's process becomes Chromium. When
  Chromium exits, that ends cage's only client, cage exits too, and
  `Restart=always` relaunches the whole stack -- including a fresh
  healthz wait. That single restart boundary (whole stack together) was
  judged simpler than an inner restart loop and sufficient for "restarts
  Chromium if it exits".
- The settings password never appears in `start-kiosk.sh`, the unit file,
  a process command line, or a log line anywhere in this kiosk. Terje logs
  into the settings page once, by hand, through the on-screen keyboard
  after first boot; the dedicated `--user-data-dir` keeps that
  `localStorage` entry across reboots.

## Screen blanking / idle

Cage does not set a DPMS timeout of its own and has no idle-inhibit flag
-- with a single fullscreen client and no compositor-level idle policy
configured, there is nothing in this stack that blanks or sleeps the
display. This is the documented default behaviour (cage does not manage
power state), not something this repo verified by leaving hardware
running unattended; if a re-verification on the real panel shows
otherwise, add `wlr-randr`'s DPMS control or a small `swayidle`-equivalent
here and update this note.

## Cursor

Touch is the only input this panel needs (USB HID, no driver required).
Neither `start-kiosk.sh` nor the unit currently hides the mouse cursor
explicitly. If a cursor is visible on the real panel and it bothers Terje,
`cage -s` (cage's built-in "hide cursor" flag, added at the compositor
level so it applies to Chromium too) is the first thing to try; adjust
`ExecStart=` in `area-kiosk.service` to `cage -s -- /usr/local/bin/start-kiosk.sh`
if so, and update this note once confirmed.

## Network recommendation (not scripted, not enforced)

The Pi is currently on `wlan0` (WiFi). For an always-on kiosk that must
survive reboots completely unattended, wired Ethernet would be more
reliable than WiFi -- this is Terje's call to make on the actual hardware,
not something any script here checks or enforces.

## Recovering / re-running

`install-kiosk.sh` is idempotent -- re-run it any time after editing a
file in this directory (e.g. after changing `TTYPath`) and it will only
touch what actually changed, then re-print the "start it yourself"
reminder. `sudo systemctl restart area-kiosk` recovers from a stuck
Chromium without a full reboot.
