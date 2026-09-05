/**
 * An `<img>` (lazy-loaded, aspect-ratio reserved so the layout never
 * reflows while it loads) with a small age badge overlaid in a corner --
 * cyan while the image is fresh, yellow once it's older than a
 * caller-supplied threshold (the camera grid's threshold is one hour, per
 * artboard 05). Handles `src: null` (no snapshot captured yet) with a
 * clear "no image" placeholder, never a broken `<img>`.
 *
 * A pure DOM builder, not reactive -- callers rebuild it on every poll,
 * same as every other page fragment in this app.
 */
import { formatNumber, t } from '../i18n/index.js';

export interface ImageWithAgeOptions {
    src: string | null;
    alt: string;
    /** When the image was captured, or `null` if unknown/never. */
    updatedAt: Date | null;
    /** The badge turns yellow once the image is older than this. */
    staleAfterMs: number;
    now?: Date;
}

/** "2 min" / "5 t" / "19 døgn" -- a compact age for the badge, escalating unit as the age grows. Distinct from `staleness.ts`'s `formatAge` (which never goes past minutes+seconds -- fine for a 30s-polled stale banner, too fine-grained for a camera image that can legitimately be days old). */
export function formatImageAge(ageMs: number): string {
    const minutes = Math.floor(ageMs / 60_000);
    if (minutes < 60) return formatNumber(minutes, t('unit.minutes'));
    const hours = Math.floor(ageMs / 3_600_000);
    if (hours < 24) return formatNumber(hours, t('unit.hours'));
    const days = Math.floor(ageMs / 86_400_000);
    return formatNumber(days, t('unit.days'));
}

export function imageWithAge(options: ImageWithAgeOptions): HTMLElement {
    const now = options.now ?? new Date();

    const root = document.createElement('div');
    root.className = 'image-with-age halftone';
    root.style.aspectRatio = '16 / 9';

    if (options.src) {
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.src = options.src;
        img.alt = options.alt;
        img.className = 'image-with-age-img';
        root.append(img);
    } else {
        const noImage = document.createElement('div');
        noImage.className = 'image-with-age-no-image';
        noImage.textContent = t('map.noImage');
        root.append(noImage);
    }

    if (options.updatedAt) {
        const ageMs = Math.max(0, now.getTime() - options.updatedAt.getTime());
        const badge = document.createElement('div');
        badge.className = 'image-with-age-badge';
        badge.classList.add(ageMs > options.staleAfterMs ? 'image-with-age-badge--stale' : 'image-with-age-badge--fresh');
        badge.textContent = formatImageAge(ageMs);
        root.append(badge);
    }

    return root;
}
