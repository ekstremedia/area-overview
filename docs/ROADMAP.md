# Roadmap

area-overview is built in phases, each landing as its own pull request. This
is a public roadmap document: it lists phase titles only, with no
infrastructure detail beyond the public hostname `area.nesthus.no`.

## Frontend pages

The app has five pages in its navigation: map, weather, aurora, tide, and
settings. A sixth, the camera viewer for the site owner's own webcams, is
dormant rather than removed: the page and its route still exist and still
resolve, but nothing links to them and the map draws no camera pins (see
`docs/adr/0004-vegvesen-layers-and-dormant-cameras.md`). Vegvesen's road
cameras, added in phase 12, are a separate thing and live on the map.

## Phases

- Phase 0: Repository skeleton and toolchain
- Phase 1: The typed data contract (shared schemas)
- Phase 2: The BFF server
- Phase 3: Settings store (server side)
- Phase 4: The reactive core
- Phase 5: App shell, navigation, and the touch/kiosk design system
- Phase 6: The map page
- Phase 7: Live layers: layer contract, ships (AIS), aircraft (ADS-B)
- Phase 8: Weather, aurora and camera-viewer pages
- Phase 9: The settings page (autosave, no save button)
- Phase 10: Publish at area.nesthus.no
- Phase 11: The Pi kiosk
- Phase 12: The Veg layer: road situations and road cameras (Statens vegvesen)
