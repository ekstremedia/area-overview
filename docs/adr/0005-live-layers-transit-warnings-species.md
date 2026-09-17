# 0005: Three more live layers -- transit, warnings, and species -- and the calls behind them

## Context

The map already showed ships, aircraft and Statens vegvesen's road
situations. Three more live views of "what is happening around here" were
built on top of that pattern: Entur's realtime buses and ferries, MET
Norway's weather warnings merged with NVE Varsom's avalanche danger
forecasts, and GBIF's species occurrence sightings. Each involved a choice
that was not simply "repeat the existing pattern with a new provider."

## Decisions

**Species uses GBIF, not Artskart.** Artsobservasjoner/Artskart is the
Norwegian species-observation service this data ultimately comes from, and
was the first choice probed. Its own public API returned `400`/`500` on
every parameter shape tried during probing -- no combination of
documented query parameters produced a working request. GBIF republishes
the same underlying Artsobservasjoner records (among many other sources)
through a stable, well-documented, keyless occurrence-search API that
answered cleanly on the first attempt. The trade-off is one layer of
indirection and GBIF's own ingestion lag on top of whatever lag
Artsobservasjoner already has, in exchange for an API that actually works;
`species/gbif.ts` is the one place this app talks to it.

**Warnings merges two independent providers behind one toggle, not two
layers.** MET Alerts (weather warnings: gale, storm surge, polar low, ice,
forest fire) and NVE Varsom (avalanche danger, 1-5) are two unrelated
upstreams, but both answer the same question a visitor glancing at the map
is asking -- "is it dangerous out there right now" -- and both are
polygons that change at most a handful of times a day, never by the
minute. Two separate toggles, two settings blocks and two poll rates for
data this similar would have doubled the settings-page surface for no
real gain in control. `WARNINGS_LAYER` in `src/shared/layers.ts` is the
single `LiveLayerSpec` for both, and `WarningsResponseSchema`'s own header
records the corollary this decision forces: the two halves must still be
able to fail independently inside that one envelope, so `routes/warnings.ts`
does not use the shared `serveCached` helper the way every single-upstream
route does -- it fetches, caches and stales each half on its own, and only
combines them into one response at the very end.

**The avalanche warning follows the viewport through a cached region list,
not a fixed region id.** A wall display that only ever showed one
hard-coded NVE forecast region would break the moment the map was panned
or the deployment moved. Instead `warnings/regions.ts` fetches NVE's whole
~46-region roster once a day into `createRegionsSource`'s cache -- region
geometry is a legal/administrative line that essentially never moves, so a
day-old copy costs nothing -- and `regionsIntersecting` computes, per
request, which regions the current bbox actually touches and where each
one's avalanche pin belongs (the centroid of that region's intersection
with the bbox, not the region's own centroid). A failed refresh falls back
to whatever was fetched before rather than losing the roster entirely: the
geometry a bbox is intersected against does not need to be fresh to the
minute, and NVE being briefly unreachable must not make every avalanche
pin disappear.

**Ferries draw twice: once via AIS as a ship, once via Entur as a transit
vehicle.** A road-replacing car ferry is a real ship and already appears
on the Ships layer through BarentsWatch AIS. It also appears as a pin on
the Transit layer. This is deliberate duplication, not an oversight:
Entur's realtime feed carries no MMSI at all, so there is no reliable key
to merge an Entur ferry fix onto an AIS ship fix even if the two layers
wanted to share one pin. More importantly, the transit pin says something
AIS cannot: which line it is running, where it is going, and how many
minutes late it is -- exactly the information someone timing a crossing
needs, and information a position-and-heading AIS fix has no field for at
all. `src/web/pages/map/transit.ts`'s own header records this reasoning
where the two layers' pins actually meet on screen (ferry pins draw in
Leaflet's default `markerPane`, already above the ships layer's canvas
glyphs, with no extra pane work needed).

**`recordedBy` is dropped from every GBIF species record, unconditionally.**
GBIF's raw occurrence records carry a `recordedBy` field naming the private
individual who reported the sighting, frequently at or near their own home
coordinate. This is real personal data reaching a public URL, not a
theoretical risk: probing GBIF live on 2026-09-17 turned up a real,
non-fictional name attached to a residential-garden bird record. The
control is `RawOccurrenceSchema` in `src/server/species/occurrences.ts`: a
closed allow-list schema (no `.passthrough()`) that simply never names
`recordedBy` as a field, so Zod strips it before any hand-written field
access could leak it, backed by a second layer of discipline in the same
file -- every `Sighting` field is built by reading one named property off
the parsed result, never by spreading the raw or parsed record. During
Phase F's review this was verified directly against live production data:
a real record carrying a real name was confirmed not to leak anywhere in
this app's serialised `/api/species` response.

## Consequences

- Species data is one hop further from the original observation than a
  direct Artskart integration would have been, and inherits whatever
  ingestion lag GBIF's own republishing adds on top of Artsobservasjoner's.
  This is accepted because the alternative does not answer requests at
  all.
- The Warnings layer's settings page renders one settings block, not two,
  and `settings.warnings.showAvalanche` is the only per-upstream control a
  visitor gets -- a deliberate simplicity trade-off. `routes/warnings.ts`
  carries more branching than a single-upstream route because it cannot
  lean on `serveCached`; the plumbing avoided at the settings layer shows
  up instead in that route's own independent stale/fresh bookkeeping.
- The avalanche pin's position is a computed intersection centroid, not a
  fixed point NVE publishes -- a small amount of server-side geometry
  (`warnings/geo.ts`) that a fixed-region design would not have needed, in
  exchange for the layer working correctly at any pan or deployment
  location.
- A ferry now costs two live-layer entries and two pins for one real
  vessel, which is intentional duplication rather than data waste: the
  two pins answer different questions, and merging them would require a
  cross-provider identity Entur's feed does not carry.
- The species layer is the one place this app must actively omit a field
  its own upstream sends, rather than merely passing through what arrives
  -- a stricter posture than the rest of the app's "model what upstream
  actually sends" approach, justified by the fact that what upstream
  sends here includes another person's private data.
