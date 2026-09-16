/**
 * The masthead: one 52px row holding the page tabs on the left and, on
 * the right, the live-layer counts, the date and clock, and the settings
 * gear.
 *
 * It used to be three rows -- an "Området" wordmark with a locality line
 * and clock, the 3px/1px rule pair, then a separate tab row. The 2026-09-07
 * design collapses all of that into this single row: on a wall display
 * that only ever shows one app, a permanent wordmark and a locality that
 * never changes are spending the scarcest thing on screen (vertical
 * space) on information nobody re-reads. The weekday and date took the
 * locality's place, since those genuinely change.
 *
 * Mounted once by `AppShell.ts` for the app's lifetime (not recreated per
 * navigation), so the `effect()`s created in here are long-lived by
 * design, same as `currentRoute`/`settings` themselves -- not the
 * per-navigation leak risk Phase 4's constraint warns about.
 */
import { currentRoute } from '../core/router.js';
import { effect, signal } from '../core/signal.js';
import { formatDayMonth, formatTime, formatWeekdayLong, t, type ParamlessKey } from '../i18n/index.js';
import { settings } from '../settings-resource.js';
import { NAV_PAGES, SETTINGS_PAGE } from '../pages/registry.js';
import { formatAge, isStale } from './staleness.js';
import { autoCycleArmed, autoCycleHeld, autoCyclePaused } from './autoCycle.js';
import { liveLayerCounts, liveLayerListing, LIVE_LAYER_GROUP_IDS, pageAccountStatus, pageFreshness, type LiveLayerGroupId } from './page-status.js';

const CLOCK_TICK_MS = 60_000;

function isActive(name: string): boolean {
    return currentRoute.get().name === name;
}

/**
 * The settings gear, inline rather than an icon font or an `<img>`: it is
 * the only icon in the app's chrome, and `stroke: currentColor` lets it
 * take the same colour as the tabs (including the active/accent state)
 * without a second source of truth for that colour.
 */
function gearIcon(): SVGSVGElement {
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '27');
    svg.setAttribute('height', '27');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    for (const radius of ['7.2', '2.9']) {
        const circle = document.createElementNS(svgNs, 'circle');
        circle.setAttribute('cx', '12');
        circle.setAttribute('cy', '12');
        circle.setAttribute('r', radius);
        svg.append(circle);
    }

    // Eight teeth at 45° intervals, as drawn in the artboard.
    const teeth: [string, string, string, string][] = [
        ['19.2', '12', '22.4', '12'],
        ['17.09', '17.09', '19.35', '19.35'],
        ['12', '19.2', '12', '22.4'],
        ['6.91', '17.09', '4.65', '19.35'],
        ['4.8', '12', '1.6', '12'],
        ['6.91', '6.91', '4.65', '4.65'],
        ['12', '4.8', '12', '1.6'],
        ['17.09', '6.91', '19.35', '4.65'],
    ];
    for (const [x1, y1, x2, y2] of teeth) {
        const line = document.createElementNS(svgNs, 'line');
        line.setAttribute('x1', x1);
        line.setAttribute('y1', y1);
        line.setAttribute('x2', x2);
        line.setAttribute('y2', y2);
        svg.append(line);
    }
    return svg;
}

/** One `<glyph> <count> <unit>` triple, with the glyph and numeral carrying their group's colour and the unit staying muted. Exactly one of the glyph and the unit is on screen at a time; which, is the width's business (`shell.css`). */
function countPart(className: string, glyph: string, onActivate?: () => void): { el: HTMLElement; set: (value: number, unit: string) => void } {
    let el: HTMLElement;
    if (onActivate) {
        // A real button, not a span with a handler: the counts are a
        // control now, and a wall display is still reached by keyboard
        // when someone plugs one in.
        const button = document.createElement('button');
        button.type = 'button';
        button.addEventListener('click', onActivate);
        button.className = 'masthead-count masthead-count--interactive';
        el = button;
    } else {
        el = document.createElement('span');
        el.className = 'masthead-count';
        // The hidden-by-age count, which opens nothing and so is not a
        // button. It still needs the accessible name set below to be
        // honoured, and `aria-label` on a generic element with no role is
        // ignored outright: a `<span>` is not in the accessibility tree
        // as anything nameable. `role="img"` makes it a leaf node whose
        // name is its label -- which is what this is, a glyph and a
        // numeral standing for one sentence -- and it matters most at
        // kiosk width, where `.masthead-count-unit` is `display: none`
        // and the visible text really is a bare number.
        el.setAttribute('role', 'img');
    }
    // The glyph lives *inside* the colour-carrying span, not beside it,
    // for two reasons: it takes the group's colour for free through
    // `fill: currentColor`, and an `<svg>` contributes no text, so
    // `.masthead-count-ships`'s `textContent` is still exactly the
    // numeral.
    const value = document.createElement('span');
    value.className = className;
    const glyphHolder = document.createElement('span');
    glyphHolder.className = 'masthead-count-glyph';
    // A build-time constant, never anything that came off the wire.
    glyphHolder.innerHTML = glyph;
    glyphHolder.setAttribute('aria-hidden', 'true');
    const number = document.createElement('span');
    number.className = 'masthead-count-value';
    value.append(glyphHolder, number);
    const unit = document.createElement('span');
    unit.className = 'masthead-count-unit';
    el.append(value, ' ', unit);
    return {
        el,
        set: (nextValue, nextUnit) => {
            number.textContent = String(nextValue);
            unit.textContent = nextUnit;
            // CSS drops the unit word at kiosk width (see `shell.css`),
            // which would drop it out of the accessible name too and
            // leave a count announced as a bare number. Saying it here
            // keeps the name the same at every width -- and it is
            // honoured either way, since the element is a `<button>` or,
            // above, a `role="img"` span.
            el.setAttribute('aria-label', `${String(nextValue)} ${nextUnit}`);
        },
    };
}

/**
 * What each countable group is called, what colour its numeral takes,
 * and the glyph that stands in for its unit word when the row is too
 * narrow for four words.
 *
 * This *is* a group's whole implementation in the masthead -- it used to
 * be a hand-written `ships`/`aircraft` pair threaded through a
 * `countPart` call, an `if` in the counts effect and a ternary in
 * `renderPanel`, which is three places to forget when a group is added.
 * Now there is one registry, and the counts effect iterates it.
 *
 * Keyed by `LiveLayerGroupId` and iterated in `LIVE_LAYER_GROUP_IDS`
 * order, both deliberately: the `Record` makes a missing entry a
 * compile error (`page-status.ts` promises a fifth group is "an entry
 * here plus an entry in `COUNT_GROUPS`", and that promise has to be the
 * compiler's, not a comment's), and taking the order from the same
 * enumeration leaves exactly one place where reading order is written
 * down.
 *
 * The glyphs are inline SVG (the same choice `gearIcon` and
 * `playPauseIcon` above make): `fill="currentColor"` puts them in their
 * group's own colour without a second source of truth for it, and there
 * is no icon font on a kiosk whose only other glyphs are drawn the same
 * way. The camera matches the road-camera pin on the map deliberately
 * (`pages/map/roadCameras.ts`'s `CAMERA_GLYPH`) -- the same thing counted
 * and drawn should look the same -- but is copied rather than imported,
 * because the shell must not pull a map module (and with it `resource`,
 * the settings store and the camera modal) into its own chunk.
 */
interface MastheadCountGroup {
    /** The class on the colour-carrying span; also the DOM hook the masthead's tests read the numeral through. */
    className: string;
    /** The unit word, shown at full width and dropped at kiosk width. */
    unitKey: ParamlessKey;
    glyph: string;
}

const SHIP_GLYPH = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M11.2 3.2h1.6v2.1h4.1v4.4h3.4l-1.5 4.4H4.8L3.3 9.7h3.4V5.3h4.5V3.2ZM8.5 7.1v2.6h7V7.1h-7ZM2.6 15.8h18.8l-2.2 3.7a2.1 2.1 0 0 1-1.8 1.1H6.6a2.1 2.1 0 0 1-1.8-1.1l-2.2-3.7Z"/></svg>`;

const AIRCRAFT_GLYPH = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M12 2.1a1.5 1.5 0 0 1 1.5 1.5v5.1l8 4.7v2.2l-8-2.4v4.2l2.5 1.9v1.7L12 19.9l-4 1.1v-1.7l2.5-1.9v-4.2l-8 2.4v-2.2l8-4.7V3.6A1.5 1.5 0 0 1 12 2.1Z"/></svg>`;

const ROAD_SITUATION_GLYPH = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor" fill-rule="evenodd"><path d="M12 2.6 23.1 21.4H0.9L12 2.6Zm0 4.1L4.5 19.4h15L12 6.7Zm-1 3.2h2v5.4h-2v-5.4Zm0 6.7h2v2h-2v-2Z"/></svg>`;

const ROAD_CAMERA_GLYPH = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M9.2 4.5h5.6l1.1 2H20a1.8 1.8 0 0 1 1.8 1.8v9.4A1.8 1.8 0 0 1 20 19.5H4A1.8 1.8 0 0 1 2.2 17.7V8.3A1.8 1.8 0 0 1 4 6.5h4.1l1.1-2Zm2.8 4.6a4.4 4.4 0 1 0 0 8.8 4.4 4.4 0 0 0 0-8.8Zm0 1.9a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z"/></svg>`;

/**
 * The transit count's own glyph -- the same bus silhouette
 * `pages/map/glyphs/bus.svg` draws on the map pin, copied rather than
 * imported for the same reason `ROAD_CAMERA_GLYPH` above is: the shell
 * must not pull a map module into its own chunk. One glyph stands for
 * both buses and ferries here, the way one count does -- the masthead's
 * row has no room to tell the two vehicle kinds apart, unlike the map pin
 * itself.
 */
const TRANSIT_GLYPH = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor" fill-rule="evenodd"><path d="M4 5.8A2 2 0 0 1 6 3.8h12a2 2 0 0 1 2 2v8.4a1.8 1.8 0 0 1-1.6 1.79V17a1 1 0 1 1-2 0v-1H7.6v1a1 1 0 1 1-2 0v-1.01A1.8 1.8 0 0 1 4 14.2V5.8Zm2.2.7v3.8h4.3V6.5H6.2Zm5.9 0v3.8h4.3V6.5h-4.3Zm5.9 0v2.9a.9.9 0 0 0 .5-.8V6.9a.4.4 0 0 0-.4-.4h-.1Z"/><circle cx="7.6" cy="15" r="1.3"/><circle cx="16.4" cy="15" r="1.3"/></svg>`;

/**
 * The hidden-by-age count is not a group -- nothing opens when it is
 * tapped -- but it sits in the same row and loses its word to the same
 * media query, and a bare unexplained numeral beside four labelled ones
 * would read as a fifth count of something. A struck-through eye says
 * "not shown" without a word.
 */
const HIDDEN_GLYPH = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path fill-rule="evenodd" d="M12 5.2c5.1 0 9.1 4.1 10.2 6.8-.5 1.3-1.7 3-3.5 4.4l-1.4-1.4c1.3-1 2.2-2.2 2.7-3-1.2-1.9-4.4-4.8-8-4.8-.9 0-1.8.2-2.6.5L7.7 6.1c1.3-.6 2.7-.9 4.3-.9Zm0 3.3c1.9 0 3.5 1.6 3.5 3.5 0 .5-.1 1-.3 1.4l-4.6-4.6c.4-.2.9-.3 1.4-.3Z"/><path fill-rule="evenodd" d="M1.8 12c.6-1.4 1.9-3.3 3.9-4.8l1.4 1.4C5.6 9.7 4.5 11 4 12c1.2 1.9 4.4 4.8 8 4.8 1 0 2-.2 2.9-.6l1.5 1.5c-1.3.7-2.8 1.1-4.4 1.1-5.1 0-9.1-4.1-10.2-6.8Zm6.7-.5 4 4a3.5 3.5 0 0 1-4-4Z"/><path d="M4.1 3.4 20.6 19.9l-1.4 1.4L2.7 4.8l1.4-1.4Z"/></svg>`;

const COUNT_GROUPS: Readonly<Record<LiveLayerGroupId, MastheadCountGroup>> = {
    ships: { className: 'masthead-count-ships', unitKey: 'masthead.shipsUnit', glyph: SHIP_GLYPH },
    aircraft: { className: 'masthead-count-aircraft', unitKey: 'masthead.aircraftUnit', glyph: AIRCRAFT_GLYPH },
    roadSituations: { className: 'masthead-count-road-situations', unitKey: 'masthead.roadSituationsUnit', glyph: ROAD_SITUATION_GLYPH },
    roadCameras: { className: 'masthead-count-road-cameras', unitKey: 'masthead.roadCamerasUnit', glyph: ROAD_CAMERA_GLYPH },
    transit: { className: 'masthead-count-transit', unitKey: 'masthead.transitUnit', glyph: TRANSIT_GLYPH },
};

/**
 * The play/pause glyph, drawn rather than lettered so it reads at a
 * glance from across the room and needs no font that carries the symbol.
 * Filled, not stroked: two bars and a triangle are shapes, not lines.
 */
function playPauseIcon(paused: boolean): SVGSVGElement {
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    if (paused) {
        // Paused: offer the way out, which is play.
        const play = document.createElementNS(svgNs, 'path');
        play.setAttribute('d', 'M7 4.5 19 12 7 19.5Z');
        svg.append(play);
        return svg;
    }

    for (const x of ['6.5', '13.5']) {
        const bar = document.createElementNS(svgNs, 'rect');
        bar.setAttribute('x', x);
        bar.setAttribute('y', '4.5');
        bar.setAttribute('width', '4');
        bar.setAttribute('height', '15');
        bar.setAttribute('rx', '0.6');
        svg.append(bar);
    }
    return svg;
}

/**
 * The slideshow control: a play/pause button with the countdown to the
 * next page under it.
 *
 * The bar is a CSS animation rather than a timer of its own -- the shell
 * already runs one clock too many, and the browser can tween a width
 * without waking any JavaScript. It restarts by being re-inserted
 * whenever `autoCycleArmed` reports a fresh interval, which is every page
 * change (auto or manual, since a manual navigation re-arms the timer)
 * and every settings change that alters the interval.
 *
 * Hidden entirely when auto-cycle is switched off in settings: there is
 * no countdown to show and nothing for the button to pause, and a dead
 * control on a wall display is worse than no control.
 */
function autoCycleControl(): { el: HTMLElement; update: () => void; dispose: () => void } {
    const el = document.createElement('div');
    el.className = 'masthead-cycle';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'masthead-cycle-button';

    const track = document.createElement('div');
    track.className = 'masthead-cycle-track';
    const bar = document.createElement('div');
    bar.className = 'masthead-cycle-bar';
    track.append(bar);

    el.append(button, track);

    button.addEventListener('click', () => {
        autoCyclePaused.set(!autoCyclePaused.get());
    });

    let renderedArmedAt: number | null = null;

    function update(): void {
        const paused = autoCyclePaused.get();
        // Held is not paused: the visitor's own choice is untouched (see
        // `holdAutoCycle`), so the button still says what *they* set. But
        // the countdown genuinely is not running, and a bar that kept
        // filling towards a page change that cannot happen would be a lie
        // the masthead told for the whole length of a follow.
        const stopped = paused || autoCycleHeld.get();
        const armed = autoCycleArmed.get();
        const enabled = settings.get().autoCycle.enabled;

        // Shown only when there is really a slideshow to control: switched
        // on, and either counting down or held by this very button. With
        // one eligible page nothing is armed, and a play button that
        // cannot make anything happen is worse than none.
        const shown = enabled && (armed !== null || stopped);
        el.hidden = !shown;
        if (!shown) return;

        button.replaceChildren(playPauseIcon(paused));
        button.setAttribute('aria-label', t(paused ? 'masthead.autoCyclePlay' : 'masthead.autoCyclePause'));
        button.title = button.getAttribute('aria-label') ?? '';
        el.classList.toggle('masthead-cycle--paused', paused);
        el.classList.toggle('masthead-cycle--stopped', stopped);

        if (!armed) {
            bar.style.removeProperty('animation-duration');
            renderedArmedAt = null;
            return;
        }

        bar.style.animationDuration = `${String(armed.intervalSeconds)}s`;
        // A CSS animation only restarts when the element does: re-inserting
        // the bar is what makes the countdown begin again on a new
        // interval, rather than carrying on from wherever the last one had
        // got to.
        if (armed.armedAt !== renderedArmedAt) {
            renderedArmedAt = armed.armedAt;
            bar.remove();
            track.append(bar);
        }
    }

    return { el, update, dispose: () => undefined };
}

export function mountMasthead(container: HTMLElement): () => void {
    container.className = 'masthead chrome';

    const row = document.createElement('nav');
    row.className = 'masthead-row';

    const tabLinks = NAV_PAGES.map((page) => {
        const link = document.createElement('a');
        link.className = 'masthead-tab';
        link.href = `#/${page.name}`;
        return { page, link };
    });
    for (const { link } of tabLinks) row.append(link);

    // Between the tabs and the status: two `auto` margins split the free
    // space, so it sits in the middle of the row without being absolutely
    // positioned over either neighbour when the row gets tight.
    const cycle = autoCycleControl();
    row.append(cycle.el);

    const status = document.createElement('div');
    status.className = 'masthead-status';

    // The counts open a list of what is actually out there; the panel is
    // built once and shown/hidden, so an open list survives a poll.
    const panel = document.createElement('div');
    panel.className = 'masthead-live-panel';
    panel.hidden = true;
    let openGroup: LiveLayerGroupId | null = null;

    function toggleGroup(group: LiveLayerGroupId): void {
        openGroup = openGroup === group ? null : group;
        renderPanel();
    }

    const layerCounts = document.createElement('span');
    layerCounts.className = 'masthead-layer-counts';
    // One part per registry entry, keyed by group id -- no group is named
    // in this file outside `COUNT_GROUPS`.
    const countParts = new Map<LiveLayerGroupId, ReturnType<typeof countPart>>();
    for (const id of LIVE_LAYER_GROUP_IDS) {
        const group = COUNT_GROUPS[id];
        const part = countPart(group.className, group.glyph, () => {
            toggleGroup(id);
        });
        countParts.set(id, part);
        layerCounts.append(part.el);
    }
    const hiddenCount = countPart('masthead-count-hidden', HIDDEN_GLYPH);
    layerCounts.append(hiddenCount.el);

    function renderPanel(): void {
        const listing = liveLayerListing.get();
        if (!listing || openGroup === null) {
            panel.hidden = true;
            panel.replaceChildren();
            return;
        }

        const entries = listing.items[openGroup];
        panel.hidden = false;
        panel.replaceChildren();

        if (entries.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'masthead-live-panel-empty';
            empty.textContent = t('masthead.livePanelEmpty');
            panel.append(empty);
            return;
        }

        for (const item of entries) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'masthead-live-row';
            const name = document.createElement('span');
            name.className = 'masthead-live-row-name';
            name.textContent = item.label;
            const detail = document.createElement('span');
            detail.className = 'masthead-live-row-detail';
            detail.textContent = item.detail;
            row.append(name, detail);
            row.addEventListener('click', () => {
                // An item may carry its own action (a road camera opens
                // its picture); panning the map to it is only the
                // default. The shell runs whichever it was handed and
                // knows what neither of them does.
                if (item.activate) item.activate();
                else listing.focus(item);
                openGroup = null;
                renderPanel();
            });
            panel.append(row);
        }
    }

    const staleBanner = document.createElement('span');
    staleBanner.className = 'masthead-stale-banner';

    const accountStatusText = document.createElement('span');
    accountStatusText.className = 'masthead-account-status';
    const accountLogoutButton = document.createElement('button');
    accountLogoutButton.type = 'button';
    accountLogoutButton.className = 'masthead-account-logout';

    const dateTime = document.createElement('div');
    dateTime.className = 'masthead-datetime';
    // The weekday is its own element so CSS can drop it when the row runs
    // out of width -- at 1024px the full "mandag 7. september · 18:18"
    // pushed the settings gear off the end of the masthead, which made
    // Settings unreachable on the kiosk.
    const dateWeekday = document.createElement('span');
    dateWeekday.className = 'masthead-date-weekday';
    const dateRest = document.createElement('span');
    dateTime.append(dateWeekday, ' ', dateRest);

    const settingsLink = document.createElement('a');
    settingsLink.className = 'masthead-settings-link';
    settingsLink.href = `#/${SETTINGS_PAGE.name}`;
    settingsLink.append(gearIcon());

    status.append(layerCounts, staleBanner, accountStatusText, accountLogoutButton, dateTime, settingsLink);
    row.append(status);
    container.append(row, panel);

    const disposers: (() => void)[] = [];

    const tick = signal(Date.now());
    // The first tick is scheduled to land on the next wall-clock minute
    // boundary, not 60s after whenever the shell happened to mount --
    // otherwise the displayed clock's minute can lag the real one by up to
    // 59s for the entire session (the masthead mounts once, for the app's
    // lifetime, and never remounts).
    let clockTimer: ReturnType<typeof setTimeout> = setTimeout(
        () => {
            tick.set(Date.now());
            clockTimer = setInterval(() => {
                tick.set(Date.now());
            }, CLOCK_TICK_MS);
        },
        CLOCK_TICK_MS - (Date.now() % CLOCK_TICK_MS),
    );
    disposers.push(() => {
        clearTimeout(clockTimer);
        clearInterval(clockTimer);
    });
    disposers.push(
        effect(() => {
            const now = new Date(tick.get());
            dateWeekday.textContent = formatWeekdayLong(now);
            dateRest.textContent = t('masthead.dateTime', { date: formatDayMonth(now), time: formatTime(now) });
        }),
    );

    disposers.push(
        effect(() => {
            const enabled = new Set(settings.get().enabledPages);
            const route = currentRoute.get();
            for (const { page, link } of tabLinks) {
                const visible = enabled.has(page.name);
                link.style.display = visible ? '' : 'none';
                link.textContent = t(page.navKey);
                link.classList.toggle('masthead-tab--active', route.name === page.name);
            }
        }),
    );

    disposers.push(
        effect(() => {
            settingsLink.setAttribute('aria-label', t('masthead.settings'));
            settingsLink.classList.toggle('masthead-tab--active', isActive(SETTINGS_PAGE.name));
        }),
    );

    disposers.push(
        effect(() => {
            const counts = liveLayerCounts.get();
            if (currentRoute.get().name !== 'map' || counts === null) {
                layerCounts.style.display = 'none';
                return;
            }
            layerCounts.style.display = '';
            for (const id of LIVE_LAYER_GROUP_IDS) countParts.get(id)?.set(counts[id], t(COUNT_GROUPS[id].unitKey));
            // Only when there is something to account for -- the ordinary
            // case must stay the plain two-number line, not one with a
            // permanent "0 hidden" on the end.
            hiddenCount.el.style.display = counts.hiddenByAge > 0 ? '' : 'none';
            hiddenCount.set(counts.hiddenByAge, t('masthead.hiddenUnit'));
        }),
    );

    // Keep an open list in step with the polls behind it, and close it
    // outright when the listing goes away (leaving the map page).
    disposers.push(
        effect(() => {
            const listing = liveLayerListing.get();
            if (!listing) openGroup = null;
            renderPanel();
        }),
    );

    disposers.push(
        effect(() => {
            tick.get(); // re-evaluate staleness on the same 60s cadence as the clock, not just when `pageFreshness` itself changes
            const freshness = pageFreshness.get();
            if (freshness === null || !isStale(freshness)) {
                staleBanner.style.display = 'none';
                return;
            }
            staleBanner.style.display = '';
            staleBanner.textContent = t('masthead.stale', { duration: formatAge(freshness.fetchedAt) });
        }),
    );

    disposers.push(
        effect(() => {
            const account = pageAccountStatus.get();
            if (account === null) {
                accountStatusText.style.display = 'none';
                accountLogoutButton.style.display = 'none';
                return;
            }
            accountStatusText.style.display = '';
            accountLogoutButton.style.display = '';
            accountStatusText.textContent = account.text;
            accountLogoutButton.textContent = account.logoutLabel;
        }),
    );

    // The slideshow control follows the pause state, the armed interval and
    // the settings that govern whether it is shown at all.
    disposers.push(
        effect(() => {
            cycle.update();
        }),
    );

    function handleLogoutClick(): void {
        pageAccountStatus.get()?.onLogout();
    }
    accountLogoutButton.addEventListener('click', handleLogoutClick);
    disposers.push(() => {
        accountLogoutButton.removeEventListener('click', handleLogoutClick);
    });

    return function dispose(): void {
        for (const disposeOne of disposers) disposeOne();
        container.innerHTML = '';
    };
}
