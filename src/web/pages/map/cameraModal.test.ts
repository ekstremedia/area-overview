/**
 * The road-camera modal: which view a tap opens, that the grid really
 * defers its downloads, that only the picture being looked at refreshes,
 * and that the idle reset takes the whole thing off the wall display.
 *
 * `IntersectionObserver` is stubbed rather than assumed: the point of the
 * grid's laziness is that a `src` is set *when the tile is seen*, so a
 * test that let every image load immediately would pass against an
 * implementation with no laziness in it at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoadCamera, RoadCameraSiteWeather } from '../../../shared/schemas/road-cameras.js';
import { IDLE_RESET_EVENT } from '../../shell/idle.js';
import { bucketedUrl, closeRoadCameraModal, openRoadCameraModal, weatherChips, ROAD_CAMERA_GRID_LIMIT } from './cameraModal.js';

function camera(n: number, overrides: Partial<RoadCamera> = {}): RoadCamera {
    return {
        id: `1900184_${String(n)}`,
        siteId: '1900184',
        name: 'Tjeldsundbrua øst',
        direction: n === 1 ? 'Evenes' : 'Tjeldsundet',
        roadNumber: 'E10',
        lat: 68.55,
        lng: 16.45,
        imageUrl: `https://kamera.atlas.vegvesen.no/api/images/1900184_${String(n)}`,
        ...overrides,
    };
}

const weather: RoadCameraSiteWeather = {
    measuredAt: '2026-09-13T11:50:00Z',
    airTemperature: 9.2,
    roadTemperature: null,
    windSpeed: 14.8,
    windGust: null,
    precipitationIntensity: null,
};

/**
 * Records what the grid observed and lets a test say "this tile scrolled
 * into view" -- the only way to tell a deferred `src` apart from one that
 * was simply set late.
 */
interface FakeObserver {
    observed: Element[];
    reveal: (element: Element) => void;
}

let observers: FakeObserver[] = [];

function stubIntersectionObserver(): void {
    vi.stubGlobal(
        'IntersectionObserver',
        class {
            private readonly callback: (entries: { target: Element; isIntersecting: boolean }[]) => void;
            private readonly record: FakeObserver;
            constructor(callback: (entries: { target: Element; isIntersecting: boolean }[]) => void) {
                this.callback = callback;
                this.record = {
                    observed: [],
                    reveal: (element: Element) => {
                        this.callback([{ target: element, isIntersecting: true }]);
                    },
                };
                observers.push(this.record);
            }
            observe(element: Element): void {
                this.record.observed.push(element);
            }
            unobserve(): void {
                /* the real one stops watching; nothing here needs to model that */
            }
            disconnect(): void {
                /* ditto */
            }
        },
    );
}

function thumbs(): HTMLImageElement[] {
    return [...document.querySelectorAll<HTMLImageElement>('.road-camera-thumb-image')];
}

beforeEach(() => {
    observers = [];
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T12:00:30Z'));
    stubIntersectionObserver();
});

afterEach(() => {
    closeRoadCameraModal();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('openRoadCameraModal', () => {
    it('opens the picture itself for a lone camera: the still, the site, the road number and the way to full screen', () => {
        openRoadCameraModal({ cameras: [camera(1)], weatherBySite: { '1900184': weather } });

        expect(document.querySelector('.road-camera-modal-grid')).toBeNull();
        const image = document.querySelector<HTMLImageElement>('.road-camera-modal-image');
        expect(image).not.toBeNull();
        expect(image?.src).toContain('https://kamera.atlas.vegvesen.no/api/images/1900184_1');

        expect(document.querySelector('.road-camera-modal-title')?.textContent).toBe('Tjeldsundbrua øst');
        expect(document.querySelector('.road-camera-modal-where')?.textContent).toBe('E10 · Evenes');
        // Full screen in place, not a new page: the stage is the element
        // that goes full screen, and it says so for a screen reader.
        expect(document.querySelector('.road-camera-modal-stage')?.getAttribute('aria-label')).toBe('Vis bildet i fullskjerm');
        // No "back" affordance: there is no grid behind a lone pin.
        expect(document.querySelector<HTMLButtonElement>('.road-camera-modal-back')?.hidden).toBe(true);
    });

    it('opens a thumbnail grid for a cluster, and a thumbnail opens that camera large with a way back', () => {
        openRoadCameraModal({ cameras: [camera(1), camera(2)], weatherBySite: {} });

        expect(document.querySelector('.road-camera-modal-grid')).not.toBeNull();
        expect(document.querySelector('.road-camera-modal-image')).toBeNull();
        expect(document.querySelector('.road-camera-modal-title')?.textContent).toBe('2 vegkamera');
        // Each tile names its own view, so a cluster that spans two
        // nearby sites still reads.
        expect([...document.querySelectorAll('.road-camera-thumb-label')].map((label) => label.textContent)).toEqual([
            'Tjeldsundbrua øst · Evenes',
            'Tjeldsundbrua øst · Tjeldsundet',
        ]);

        document.querySelectorAll<HTMLButtonElement>('.road-camera-thumb')[1]?.click();

        expect(document.querySelector('.road-camera-modal-grid')).toBeNull();
        expect(document.querySelector<HTMLImageElement>('.road-camera-modal-image')?.src).toContain('1900184_2');
        const back = document.querySelector<HTMLButtonElement>('.road-camera-modal-back');
        expect(back?.hidden).toBe(false);

        back?.click();
        expect(document.querySelector('.road-camera-modal-grid')).not.toBeNull();
    });

    it('defers every thumbnail until it is actually on screen -- there are no thumbnail URLs, so each one is a full 800x600 JPEG', () => {
        openRoadCameraModal({ cameras: [camera(1), camera(2), camera(3)], weatherBySite: {} });

        // Nothing has been asked for yet: no `src` attribute at all, which
        // is what keeps the browser from starting three downloads.
        expect(thumbs().map((image) => image.getAttribute('src'))).toEqual([null, null, null]);
        expect(thumbs().every((image) => image.loading === 'lazy')).toBe(true);

        const observer = observers[0];
        expect(observer?.observed).toHaveLength(3);

        const [first] = thumbs();
        if (!first) throw new Error('no thumbnails rendered');
        observer?.reveal(first);

        expect(first.getAttribute('src')).toContain('1900184_1');
        expect(
            thumbs()
                .slice(1)
                .map((image) => image.getAttribute('src')),
        ).toEqual([null, null]);
    });

    it('caps the grid at twelve, with "vis alle" for the rest', () => {
        const many = Array.from({ length: 15 }, (_, index) => camera(index + 1));
        openRoadCameraModal({ cameras: many, weatherBySite: {} });

        expect(thumbs()).toHaveLength(ROAD_CAMERA_GRID_LIMIT);
        const showAll = document.querySelector<HTMLButtonElement>('.road-camera-modal-show-all');
        expect(showAll?.textContent).toBe('Vis alle (3 til)');

        showAll?.click();

        expect(thumbs()).toHaveLength(15);
        // Still deferred: "show all" reveals the tiles, not the bytes.
        expect(
            thumbs()
                .slice(12)
                .map((image) => image.getAttribute('src')),
        ).toEqual([null, null, null]);
        expect(document.querySelector('.road-camera-modal-show-all')).toBeNull();
    });

    it('re-sets the src of the visible image on the 60s bucket, and never a thumbnail', async () => {
        openRoadCameraModal({ cameras: [camera(1)], weatherBySite: {} });
        const image = document.querySelector<HTMLImageElement>('.road-camera-modal-image');
        const before = image?.src;

        // Inside the same minute bucket: the URL is identical, so a
        // re-set would be a no-op anyway.
        expect(bucketedUrl(camera(1).imageUrl, Date.parse('2026-09-13T12:00:59Z'))).toBe(before);

        await vi.advanceTimersByTimeAsync(60_000);

        expect(image?.src).not.toBe(before);
        expect(image?.src).toContain('https://kamera.atlas.vegvesen.no/api/images/1900184_1');
        closeRoadCameraModal();

        // ...and a grid does not refresh at all: twelve full-size JPEGs
        // re-downloading every minute is exactly the traffic this must not
        // generate against a service with no SLA.
        openRoadCameraModal({ cameras: [camera(1), camera(2)], weatherBySite: {} });
        const observer = observers[observers.length - 1];
        for (const thumb of thumbs()) observer?.reveal(thumb);
        const loaded = thumbs().map((thumbnail) => thumbnail.src);

        await vi.advanceTimersByTimeAsync(60_000 * 5);

        expect(thumbs().map((thumbnail) => thumbnail.src)).toEqual(loaded);
    });

    it('closes on the idle reset, so the wall display does not sit on a webcam all night', () => {
        openRoadCameraModal({ cameras: [camera(1)], weatherBySite: {} });
        expect(document.querySelector('.road-camera-modal')).not.toBeNull();

        window.dispatchEvent(new CustomEvent(IDLE_RESET_EVENT));

        expect(document.querySelector('.road-camera-modal')).toBeNull();
    });

    it('closes on its own close control, on the veil, and on Escape', () => {
        openRoadCameraModal({ cameras: [camera(1)], weatherBySite: {} });
        document.querySelector<HTMLButtonElement>('.road-camera-modal-close')?.click();
        expect(document.querySelector('.road-camera-modal')).toBeNull();

        openRoadCameraModal({ cameras: [camera(1)], weatherBySite: {} });
        document.querySelector<HTMLElement>('.road-camera-modal-veil')?.click();
        expect(document.querySelector('.road-camera-modal')).toBeNull();

        openRoadCameraModal({ cameras: [camera(1)], weatherBySite: {} });
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(document.querySelector('.road-camera-modal')).toBeNull();
    });

    it('never leaves two overlays stacked: opening a second modal replaces the first', () => {
        openRoadCameraModal({ cameras: [camera(1)], weatherBySite: {} });
        openRoadCameraModal({ cameras: [camera(2)], weatherBySite: {} });

        expect(document.querySelectorAll('.road-camera-modal')).toHaveLength(1);
        expect(document.querySelector<HTMLImageElement>('.road-camera-modal-image')?.src).toContain('1900184_2');
    });

    it('shows the road-weather readings that exist for the camera’s site, and only those', () => {
        openRoadCameraModal({ cameras: [camera(1)], weatherBySite: { '1900184': weather } });

        // Road surface temperature, gust and precipitation are all null on
        // this station -- nulls are the norm here, not an error -- so they
        // are absent rather than shown as dashes.
        expect([...document.querySelectorAll('.road-camera-modal-weather-item')].map((chip) => chip.textContent)).toEqual([
            'Luft 9,2 °C',
            'Vind 14,8 m/s',
        ]);
    });

    it('shows nothing at all where the site has no co-located weather station, which is most of them', () => {
        openRoadCameraModal({ cameras: [camera(1)], weatherBySite: {} });

        expect(document.querySelectorAll('.road-camera-modal-weather-item')).toHaveLength(0);
    });
});

describe('weatherChips', () => {
    it('pairs a gust with its mean when both are present', () => {
        expect(weatherChips({ ...weather, windGust: 21.4 })).toEqual(['Luft 9,2 °C', 'Vind 14,8 m/s (kast 21,4 m/s)']);
    });

    it('still shows a gust that arrived with no mean beside it', () => {
        expect(weatherChips({ ...weather, airTemperature: null, windSpeed: null, windGust: 21.4 })).toEqual(['Vindkast 21,4 m/s']);
    });

    it('shows the road surface temperature and precipitation intensity when upstream sent them', () => {
        expect(weatherChips({ ...weather, roadTemperature: -1.5, precipitationIntensity: 0.4 })).toEqual([
            'Luft 9,2 °C',
            'Vegbane −1,5 °C',
            'Vind 14,8 m/s',
            'Nedbør 0,4 mm/t',
        ]);
    });

    it('is empty when every reading is null, rather than a row of dashes', () => {
        expect(
            weatherChips({
                measuredAt: weather.measuredAt,
                airTemperature: null,
                roadTemperature: null,
                windSpeed: null,
                windGust: null,
                precipitationIntensity: null,
            }),
        ).toEqual([]);
    });
});

describe('bucketedUrl', () => {
    it('is stable inside a minute and different across one -- upstream publishes about once a minute and sends no cache headers', () => {
        const url = 'https://kamera.atlas.vegvesen.no/api/images/1900184_1';
        const at = Date.parse('2026-09-13T12:00:05Z');

        expect(bucketedUrl(url, at)).toBe(bucketedUrl(url, at + 50_000));
        expect(bucketedUrl(url, at)).not.toBe(bucketedUrl(url, at + 60_000));
        // The upstream path is untouched; only a query parameter is added.
        expect(bucketedUrl(url, at).startsWith(`${url}?`)).toBe(true);
    });
});
