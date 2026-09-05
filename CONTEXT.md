# area-overview

A wall-display view of Terje's surroundings in Vesterålen: a live map with
cameras, ships and aircraft, plus weather, aurora and camera pages. It reads
data that already exists on `nesthus.no` and adds nothing to it.

## Language

### Where data comes from

**Upstream**:
The `nesthus.no` Laravel API that the BFF proxies for weather, aurora and
cameras. There is exactly one upstream.
_Avoid_: backend, the site, the API (ambiguous with this app's own API)

**Provider**:
An external live-data service the BFF calls directly because upstream has
nothing for it: BarentsWatch (ships) and an ADS-B aggregator (aircraft).
_Avoid_: upstream (a provider is not the upstream), source, feed

**BFF**:
This project's server. It fetches from upstream and providers, validates and
caches, serves the built frontend, and holds the settings file.
_Avoid_: backend, proxy, API server

### What is shown

**Page**:
One of the app's screens reachable by its own route: map, weather, aurora,
tide, cameras, settings.
_Avoid_: view, tab, screen, route (a route is the address, not the thing)

**Masthead**:
The band at the top of every page: the app name, the locality, the clock,
the thick–thin rule pair, and the row of page tabs with live counts and the
stale banner. Built once, shared by all pages.
_Avoid_: header, nav bar, toolbar, app bar

**Footer line**:
The single line at the foot of every page: data attribution on the left,
"updated … ago" on the right.
_Avoid_: status bar, footer, colophon

**Base map**:
The tile layer under everything else, chosen by theme.
_Avoid_: tiles, background, basemap

**Live layer**:
A set of moving markers on the map fed by a polled bbox query to the BFF,
with its own settings block, attribution and on/off toggle.
_Avoid_: overlay, feature, plugin, data layer

**Ship**:
A vessel reported by AIS via BarentsWatch, identified by MMSI. One live layer.
_Avoid_: vessel, boat

**Aircraft**:
An aircraft reported by ADS-B via a provider, identified by ICAO hex. One live
layer.
_Avoid_: plane, flight

**Camera**:
A webcam known to upstream, identified by its stable `camera_id` slug.
Upstream knows its name and current image but not where it is. Not a live
layer: static markers, no bbox polling.
_Avoid_: webcam, cam, feed

**Placement**:
The coordinates this app stores for a camera, keyed by `camera_id`. A camera
without a placement is "unplaced" and absent from the map.
_Avoid_: position, location (upstream's free-text field), coordinates

**Home view**:
The stored map centre and zoom the map opens at and returns to after idle.
_Avoid_: default view, map centre, start position

**Point forecast**:
The weather forecast for a tapped map point, fetched at ~1 km rounding.
_Avoid_: click forecast, custom location

**Idle reset**:
Returning the app to the map page at the home view after a period with no
touch. A shared setting; 0 disables it.
_Avoid_: screensaver, timeout, auto-return

**Kiosk**:
The Chromium full-screen session on the 7" 1024×600 touchscreen, showing the
public URL. It only displays; it runs no code of this project. It lives on the
Pi 5 that also serves `pi.nesthus.no`, as its own unprivileged user.
_Avoid_: the Pi (that box has another job), pi5ai (the host, not the role),
wall display, screen

### Settings

**Shared settings**:
Settings stored by the BFF and identical on every device: language, home
view, placements, idle reset, night schedule, live-layer options, enabled
pages. Changed from any logged-in device, seen by all.
_Avoid_: app settings, server settings, config

**Device settings**:
Settings that belong to one browser and never leave it: theme, font scale.
_Avoid_: local settings, display settings, preferences

**Night schedule**:
A shared setting that switches the display to dark, dimmed or off between two
clock times.
_Avoid_: sleep, screensaver, night mode (a mode is what it switches to)

### Access

**Settings password**:
The single shared passphrase, chosen by Terje, that authorises writes to
shared settings. Read is public. Typed once per device; that device stays
logged in until it logs out or the password changes.
_Avoid_: token, API key, PIN, secret

**Logged-in device**:
A browser that holds the settings password and may edit shared settings.
Never locks by itself.
_Avoid_: unlocked, admin, authenticated session

**Provider credentials**:
Secrets the BFF uses to talk to a provider (BarentsWatch client id/secret).
Never leave the server.
_Avoid_: token, API key
