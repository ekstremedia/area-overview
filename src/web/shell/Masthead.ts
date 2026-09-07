/**
 * The masthead: brand + locality + clock, the 3px/1px rule pair (the
 * design's one deliberate exception to "no dividers" -- see
 * `design/broadsheet/readme.md`'s Don't list), and a 52px tab row with
 * live-layer counts / a stale banner / the Settings link at the right.
 * Mounted once by `AppShell.ts` for the app's lifetime (not recreated
 * per navigation), so the `effect()`s created in here are long-lived by
 * design, same as `currentRoute`/`settings` themselves -- not the
 * per-navigation leak risk the phase's Phase 4 constraint warns about.
 */
import { currentRoute } from '../core/router.js';
import { effect, signal } from '../core/signal.js';
import { formatTime, t } from '../i18n/index.js';
import { settings } from '../settings-resource.js';
import { NAV_PAGES, SETTINGS_PAGE, pageForRoute } from '../pages/registry.js';
import { formatAge, isStale } from './staleness.js';
import { liveLayerCounts, pageAccountStatus, pageFreshness, pageLocalityOverride } from './page-status.js';

const CLOCK_TICK_MS = 60_000;

function isActive(name: string): boolean {
    return currentRoute.get().name === name;
}

export function mountMasthead(container: HTMLElement): () => void {
    container.className = 'masthead chrome';

    const top = document.createElement('div');
    top.className = 'masthead-top';

    const brand = document.createElement('div');
    brand.className = 'masthead-brand';

    const locality = document.createElement('div');
    locality.className = 'masthead-locality';

    const clock = document.createElement('div');
    clock.className = 'masthead-clock';

    top.append(brand, locality, clock);

    const ruleThick = document.createElement('div');
    ruleThick.className = 'masthead-rule-thick';
    const ruleThin = document.createElement('div');
    ruleThin.className = 'masthead-rule-thin';

    const tabRow = document.createElement('nav');
    tabRow.className = 'masthead-tabs';

    const tabLinks = NAV_PAGES.map((page) => {
        const link = document.createElement('a');
        link.className = 'masthead-tab';
        link.href = `#/${page.name}`;
        return { page, link };
    });
    for (const { link } of tabLinks) tabRow.append(link);

    const status = document.createElement('div');
    status.className = 'masthead-status';

    const layerCounts = document.createElement('span');
    layerCounts.className = 'masthead-layer-counts';

    const staleBanner = document.createElement('span');
    staleBanner.className = 'masthead-stale-banner';

    const settingsLink = document.createElement('a');
    settingsLink.className = 'masthead-settings-link';
    settingsLink.href = `#/${SETTINGS_PAGE.name}`;

    const accountStatusText = document.createElement('span');
    accountStatusText.className = 'masthead-account-status';
    const accountLogoutButton = document.createElement('button');
    accountLogoutButton.type = 'button';
    accountLogoutButton.className = 'masthead-account-logout';

    status.append(layerCounts, staleBanner, accountStatusText, accountLogoutButton, settingsLink);
    tabRow.append(status);

    container.append(top, ruleThick, ruleThin, tabRow);

    const disposers: (() => void)[] = [];

    disposers.push(
        effect(() => {
            brand.textContent = t('brand.title');
        }),
    );

    disposers.push(
        effect(() => {
            const route = currentRoute.get();
            const override = pageLocalityOverride.get();
            locality.textContent = override ?? t(pageForRoute(route).localityKey);
        }),
    );

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
            clock.textContent = formatTime(new Date(tick.get()));
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
            settingsLink.textContent = t(SETTINGS_PAGE.navKey);
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
            // The hidden segment appears only when there is something to
            // account for -- the ordinary case must stay the plain two-number
            // line, not a line with a permanent "0 hidden" on the end.
            layerCounts.textContent =
                counts.hiddenByAge > 0
                    ? t('masthead.layerCountsHidden', { ships: counts.ships, aircraft: counts.aircraft, hidden: counts.hiddenByAge })
                    : t('masthead.layerCounts', { ships: counts.ships, aircraft: counts.aircraft });
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
