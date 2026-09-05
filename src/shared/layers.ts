/**
 * Reserved for the `LiveLayerSpec<T>` contract that every live map layer
 * (ships, aircraft, and any future live layer) will implement: a common
 * shape covering how a layer polls its data source, validates the
 * response, and renders/updates its markers.
 *
 * That contract is intentionally not defined yet -- it lands in a later
 * phase (Phase 7, alongside the BarentsWatch/ADS-B clients) once there are
 * at least two concrete layers to generalise from. This file exists now so
 * the shared module has a stable home for it.
 */
export {};
