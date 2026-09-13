/**
 * **The flag.** Terje's own cameras are dormant, not deleted: two exist,
 * one is online, and they come down when he moves -- so the app stops
 * *showing* them while keeping every line of code, every route and every
 * byte of `data/settings.json` that serves them.
 *
 * Flipping `CAMERAS_DORMANT` to `false` brings all of it back in one
 * edit. What reads it, and what each one restores:
 *
 *  - `pages/registry.ts`       -- the masthead tab (the route itself stays
 *                                 registered either way, so an old
 *                                 `#/cameras/<id>` bookmark resolves now)
 *  - `shell/autoCycle.ts`      -- the cameras page in the kiosk slideshow
 *  - `pages/settings/General.ts` -- its row in the page-toggle list
 *  - `pages/SettingsPage.ts`   -- the Kameraer section (the placement editor)
 *  - `pages/map/markers.ts`    -- the camera pins on the map
 *  - `pages/map/popup.ts`      -- the marker popup's "Open camera →" link
 *
 * Two things are deliberately *not* flag-driven, because a flag cannot
 * reach them:
 *
 *  - `'cameras'` stays in `PageIdSchema` and in `Route`, so an existing
 *    `data/settings.json` with `'cameras'` in `enabledPages` still
 *    parses and an old bookmark still resolves. Nothing to switch.
 *  - `enabledPages`' *default* in `shared/schemas/settings.ts` lost
 *    `'cameras'`, which only affects a display that has never had a
 *    settings file. Flipping this flag back on a machine with existing
 *    settings restores the tab from what is already on disk; a fresh
 *    install would also want that default put back.
 *
 * Typed `boolean` rather than left as the literal `true` on purpose: the
 * literal type would make every `if (CAMERAS_DORMANT)` branch dead code
 * to the compiler, and half of this file's point is that the other
 * branch still compiles.
 */
// eslint-disable-next-line @typescript-eslint/no-inferrable-types -- the annotation is the point: see the paragraph above.
export const CAMERAS_DORMANT: boolean = true;
