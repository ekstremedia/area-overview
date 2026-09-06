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
  by the policy entry `basemaps.cartocdn.com` without a leading dot, which
  matches the host and all its subdomains in Chromium's URLAllowlist format)
- `tile.openstreetmap.org` (light theme)

`src/web/index.html` self-hosts its one font (`Source Serif 4`, woff2, no
external font CDN), so no font host needed in the policy. No other
external host is fetched from `src/web` -- everything else (weather, AIS,
aurora, etc.) is server-proxied through the BFF at `area.nesthus.no`
itself.

## Chromium managed-policy configuration notes

`area-kiosk.json` is installed to `/etc/chromium/policies/managed/` and
defines Chromium's behavior:

- `RestoreOnStartup: 4` — restores the URLs in `RestoreOnStartupURLs` on
  startup (value `1` would restore the last session and ignore the URL list).
  This ensures the kiosk always opens `https://area.nesthus.no/` rather than
  whatever was last viewed.
- `URLAllowlist` — only allows navigation to `area.nesthus.no` (the app
  itself, served through Apache), `basemaps.cartocdn.com` (map tiles), and
  `tile.openstreetmap.org` (alternate map tiles). All other URLs are blocked
  by the `URLBlocklist: ["*"]` catchall.
- `IncognitoModeAvailability: 1` — Disabled (integer enum; a string value
  would be silently ignored). `DeveloperToolsAvailability: 2` — Disabled.
  `PasswordManagerEnabled: false`, `BrowserAddPersonEnabled: false`,
  `BrowserGuestModeEnabled: false` — all prevent user escapes from the kiosk
  view.

## Running it

From a checkout of this repo on pi5ai itself (or copied over), as root,
with interactive `sudo`:

```bash
sudo ./deploy/kiosk/install-kiosk.sh <nuc-lan-ip>
```

Replace `<nuc-lan-ip>` with the NUC's real LAN IP (this repo is public, so
no real IP is committed anywhere in these files). The script:

- creates the `kiosk` system user (no login password, home
  `/home/kiosk`, added to whichever of `render`/`video` groups
  actually exist on this system),
- installs `cage`, `chromium` and `curl` if missing,
- adds `<nuc-lan-ip> area.nesthus.no` to `/etc/hosts` if not already
  present (skips the router hairpin; the certificate is valid for the
  name either way, so this is an optimisation, not a correctness fix),
- installs the Chromium managed policy to
  `/etc/chromium/policies/managed/area-kiosk.json`,
- installs `start-kiosk.sh` to `/usr/local/bin/start-kiosk.sh` (owned by
  root, executable) -- kept out of `/home/kiosk` deliberately, so that
  directory holds only the Chromium profile,
- installs `area-kiosk.service` to `/etc/systemd/system/` and runs
  `systemctl daemon-reload`,
- prints a summary of what changed vs. what was already in place.

It never touches Apache, gunicorn, `pi`'s home/session/lightdm config, or
any firewall rule, on the Pi or the NUC.

**It deliberately does not enable the service.** Before enabling and starting it:

1. **Confirm the VT assignment and understand the display takeover.** `area-kiosk.service`
   is bound to `/dev/tty8` (above `NAutoVTs=6` and above lightdm's VT7, so logind
   will never auto-spawn a getty on it or steal the kiosk via the `Conflicts=`
   mechanism). This choice protects the kiosk from accidental keyboard input (e.g.,
   Ctrl+Alt+F2) that would trigger logind's `getty@tty8.service` and cause an
   unrecoverable kiosk death.

    **When the service starts, it actively takes over the 7" panel by switching the
    foreground VT to 8.** This is necessary because logind only grants DRM master
    (required for the Wayland compositor) to the active/foreground session on the
    seat. The service uses `ExecStartPost=+/usr/bin/chvt 8` to force the panel's
    display to the kiosk. Without this, cage would start successfully but the panel
    would stay on pi's labwc desktop (tty7) because lightdm's `minimum-vt=7` makes
    it foreground by default.

    **Known tradeoff:** While the kiosk is active on VT8, pi's own desktop session
    on VT7 becomes inactive. wlroots doesn't composite inactive sessions, so Terje's
    `rpi-connect` remote screen-sharing (wayvnc) will freeze or show a stale image
    while the kiosk is foreground. **The remote shell access through rpi-connect
    remains fully functional** — screen-sharing is the only feature affected.

    You can switch back to pi's desktop manually (restoring rpi-connect screen-share)
    with **Ctrl+Alt+F7**, and return to the kiosk with **Ctrl+Alt+F8**. This tradeoff
    was an explicit, informed design decision made after understanding the display
    architecture constraints on this hardware.

    Confirm that VT8 is free before enabling: `ls /dev/tty8` should succeed, and
    `systemctl status getty@tty8.service` should not be active.

2. Enable it:

    ```bash
    sudo systemctl enable area-kiosk.service
    ```

3. Start it and watch it come up:

    ```bash
    sudo systemctl start area-kiosk
    sudo systemctl status area-kiosk
    journalctl -u area-kiosk -f
    ```

4. Confirm pi5ai's existing services are unaffected:

    ```bash
    free -m                    # compare against the 6754 MB baseline above
    curl -fsS http://127.0.0.1/        # Apache landing page, unchanged
    curl -fsS http://127.0.0.1/docs/   # Flask OCR service, unchanged
    ```

## How the pieces fit together

- `area-kiosk.service` is a systemd **system** unit running as `User=kiosk`
  with `PAMName=login`, bound to a specific VT (`TTYPath=/dev/tty8`) via
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

Cage does not set a DPMS timeout or blanking interval of its own and has no
idle-inhibit flag. With a single fullscreen client and no compositor-level
idle policy configured, cage's default behavior (via wlroots) is to not
blank the display. This is documented cage behavior, not something this repo
has independently verified on the real 7" panel. If the screen blanks in
practice and needs to stay on, possible fixes include:

- `wlr-dpms` (https://git.sr.ht/~dsemy/wlr-dpms) — a utility for direct DPMS
  control under wlroots. Whether it is available on the Pi's image is
  unverified; if needed, it would have to be installed first.
- The kernel parameter `consoleblank=0` in `/boot/firmware/cmdline.txt` would
  prevent console blanking (though this shouldn't matter under a Wayland
  compositor).

**Both are unverified — monitor the real hardware and update this section if
the screen blanks.**

## Cursor and input injection security

Touch is the only input this panel needs (USB HID, no driver required).

Cage 0.2.0 has five command-line flags: `-d -h -m -s -v`. None of them control
cursor visibility. The `-s` flag specifically means "allow VT switching" (the
opposite of what a kiosk wants), not cursor-hiding, so `cage -s` was a mistake
and has been removed.

### What was actually found on the real hardware

The touchscreen itself (`QDtech MPI7003`, `EV=0x1b`, no `EV_REL`) is correctly
touch-only and would never create a pointer on its own. **However**, two other
devices exist on the same seat: `vc4-hdmi-0` and `vc4-hdmi-1`, the kernel's
HDMI-CEC remote-control input devices (created by the RC subsystem for each
HDMI controller, visible in `dmesg` as `rc rc0: vc4-hdmi-0` / `rc rc1: vc4-hdmi-1`).
Their evdev capabilities are `EV=0x100017` → `SYN KEY REL MSC REP` with `REL_X|REL_Y`,
and udev tags them `ID_INPUT_POINTINGSTICK=1` and `ID_INPUT_KEY=1`. libinput
treats `POINTINGSTICK`-tagged devices as pointers, so it will enumerate a pointer
on this seat regardless of there being no mouse — `loginctl seat-status seat0`
confirms both vc4-hdmi devices are listed on `seat0`.

### The fix

`install-kiosk.sh` now installs a udev rule (`99-kiosk-ignore-cec.rules`)
that sets `LIBINPUT_IGNORE_DEVICE=1` on both CEC devices, making libinput
never see them at all. This removes the phantom pointer at the source.

**More importantly, this closes a real input-injection security surface:**
these same CEC devices carry `EV_KEY`, so anything on the HDMI/CEC bus capable
of sending CEC remote-control signals could otherwise inject keystrokes into
whatever has seat focus (the kiosk's Chromium), compromising a kiosk that's
supposed to be locked down to a Chromium managed policy (URL allow/blocklist).
The udev rule closes that surface independently of the cursor issue.

The `XCURSOR_THEME` and `XCURSOR_PATH` approach (setting a transparent cursor
theme) remains documented as a fallback only, in case some other device the
Pi session hasn't identified still produces a visible cursor after this rule
is applied. The primary fix is at the source (udev rule).

**Note:** this rule disables HDMI-CEC remote input for _any_ libinput
compositor on this Pi, not just the kiosk -- it's a system-wide udev rule,
not scoped to the `kiosk` user or session. If Terje ever wants to drive this
Pi from a TV remote over CEC, this is where that got turned off. Trivial
today (the panel almost certainly has no CEC), but worth being able to find
later.

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
