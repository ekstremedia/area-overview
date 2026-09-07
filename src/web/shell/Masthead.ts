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
import { formatDayMonth, formatTime, formatWeekdayLong, t } from '../i18n/index.js';
import { settings } from '../settings-resource.js';
import { NAV_PAGES, SETTINGS_PAGE } from '../pages/registry.js';
import { formatAge, isStale } from './staleness.js';
import { liveLayerCounts, liveLayerListing, pageAccountStatus, pageFreshness } from './page-status.js';

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

/** One `<count> <unit>` pair, with the numeral carrying its layer's colour and the unit staying muted. */
function countPart(className: string, onActivate?: () => void): { el: HTMLElement; set: (value: number, unit: string) => void } {
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
    }
    const value = document.createElement('span');
    value.className = className;
    const unit = document.createElement('span');
    el.append(value, ' ', unit);
    return {
        el,
        set: (nextValue, nextUnit) => {
            value.textContent = String(nextValue);
            unit.textContent = nextUnit;
        },
    };
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

    const status = document.createElement('div');
    status.className = 'masthead-status';

    // The counts open a list of what is actually out there; the panel is
    // built once and shown/hidden, so an open list survives a poll.
    const panel = document.createElement('div');
    panel.className = 'masthead-live-panel';
    panel.hidden = true;
    let openGroup: 'ships' | 'aircraft' | null = null;

    function toggleGroup(group: 'ships' | 'aircraft'): void {
        openGroup = openGroup === group ? null : group;
        renderPanel();
    }

    const layerCounts = document.createElement('span');
    layerCounts.className = 'masthead-layer-counts';
    const shipsCount = countPart('masthead-count-ships', () => {
        toggleGroup('ships');
    });
    const aircraftCount = countPart('masthead-count-aircraft', () => {
        toggleGroup('aircraft');
    });
    const hiddenCount = countPart('masthead-count-hidden');
    layerCounts.append(shipsCount.el, aircraftCount.el, hiddenCount.el);

    function renderPanel(): void {
        const listing = liveLayerListing.get();
        if (!listing || openGroup === null) {
            panel.hidden = true;
            panel.replaceChildren();
            return;
        }

        const entries = openGroup === 'ships' ? listing.ships : listing.aircraft;
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
                listing.focus(item);
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
            shipsCount.set(counts.ships, t('masthead.shipsUnit'));
            aircraftCount.set(counts.aircraft, t('masthead.aircraftUnit'));
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
