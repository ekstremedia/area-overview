# 0001: Vanilla TypeScript instead of a frontend framework

## Context

area-overview is, first and foremost, a TypeScript learning vehicle. It
renders a live map plus a handful of data pages (weather, aurora, tide,
cameras, settings) with modest interactivity: polling, filtering layers,
editing settings. None of that requires the routing, component lifecycle, or
virtual-DOM diffing a framework like React, Vue, or Svelte provides.

## Decision

Build the frontend in vanilla TypeScript with Vite as the build tool, and
hand-write a small reactive core (signals-style state with DOM bindings)
rather than adopting a framework. Leaflet is used for the map itself, since
reimplementing map rendering has no learning value here.

## Consequences

- More code to write by hand for state-to-DOM binding than a framework would
  require, which is the point: it is the mechanism being learned.
- No framework upgrade treadmill, no framework-specific idioms to look up.
- Bundle size stays small by construction, which matters for the kiosk
  deployment target (phase 11) on modest hardware.
- Discipline is required to keep the hand-written reactive core from growing
  into an unmaintained mini-framework; phase 4 defines its scope deliberately
  narrow.
