/**
 * Tap-empty-map point forecast: `GET /api/weather?lat=&lng=` for the
 * tapped spot (see artboard 01's bottom-right panel). Two correctness
 * properties matter more than anything else here, because a kiosk user
 * can tap several spots in a row before the first response lands:
 *
 *  1. A rapid second tap aborts the first request's `fetch` (so it stops
 *     wasting bandwidth/BFF load), via `AbortController`.
 *  2. Even if an abort doesn't actually stop a fetch in time on some
 *     browser/network edge case, a monotonically increasing request id is
 *     checked at every resolution point -- a response that isn't for the
 *     *latest* request is discarded, never displayed, even if it resolves
 *     after a newer request's response already landed.
 *
 * Coordinates are rounded to 2 decimals client-side before the request is
 * built (matching the server's own internal rounding -- see
 * `src/server/routes/weather.ts`), so repeated taps near the same spot
 * naturally hit the server's point-forecast cache.
 */
import { WeatherSchema, type Weather } from '../../../shared/schemas/weather.js';
import { effect, signal, type ReadonlySignal } from '../../core/signal.js';
import { formatNumber, t, type ParamlessKey } from '../../i18n/index.js';

export type PointForecastState =
    | { status: 'idle' }
    | { status: 'loading'; lat: number; lng: number }
    | { status: 'ready'; lat: number; lng: number; weather: Weather }
    | { status: 'error'; lat: number; lng: number; error: Error };

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

export interface PointForecastController {
    state: ReadonlySignal<PointForecastState>;
    /** Rounds `lat`/`lng` itself -- callers pass the raw tapped coordinates. */
    requestForecast(lat: number, lng: number): void;
    dispose(): void;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createPointForecastController(fetchImpl: FetchLike = fetch): PointForecastController {
    const state = signal<PointForecastState>({ status: 'idle' });
    let requestId = 0;
    let inFlight: AbortController | undefined;

    function requestForecast(rawLat: number, rawLng: number): void {
        const lat = round2(rawLat);
        const lng = round2(rawLng);

        inFlight?.abort();
        const controller = new AbortController();
        inFlight = controller;
        const myRequestId = ++requestId;

        state.set({ status: 'loading', lat, lng });

        void (async () => {
            try {
                const response = await fetchImpl(`/api/weather?lat=${String(lat)}&lng=${String(lng)}`, { signal: controller.signal });
                if (myRequestId !== requestId) return; // superseded by a later tap
                if (!response.ok) {
                    state.set({ status: 'error', lat, lng, error: new Error(`GET /api/weather responded ${String(response.status)}`) });
                    return;
                }
                const json: unknown = await response.json();
                if (myRequestId !== requestId) return;
                const parsed = WeatherSchema.safeParse(json);
                if (!parsed.success) {
                    state.set({ status: 'error', lat, lng, error: new Error('GET /api/weather returned a payload that failed schema validation') });
                    return;
                }
                state.set({ status: 'ready', lat, lng, weather: parsed.data });
            } catch (cause) {
                if (myRequestId !== requestId) return;
                if (cause instanceof DOMException && cause.name === 'AbortError') return; // intentionally superseded, not a real error
                state.set({ status: 'error', lat, lng, error: cause instanceof Error ? cause : new Error(String(cause)) });
            }
        })();
    }

    function dispose(): void {
        inFlight?.abort();
    }

    return { state, requestForecast, dispose };
}

const COMPASS_KEYS: readonly ParamlessKey[] = [
    'compass.n',
    'compass.ne',
    'compass.e',
    'compass.se',
    'compass.s',
    'compass.sw',
    'compass.w',
    'compass.nw',
];

/** An 8-point compass word for a wind direction in degrees (0=N, 90=E, ...). */
function compassWord(degrees: number): string {
    const normalized = ((degrees % 360) + 360) % 360;
    const index = Math.round(normalized / 45) % 8;
    return t(COMPASS_KEYS[index] ?? 'compass.n');
}

/**
 * A best-effort, deliberately non-exhaustive humanization of MET Norway's
 * Yr `symbol_code` vocabulary (~50 codes) into the condition fragment the
 * artboard shows (e.g. "lett regn" for `lightrain_day`). Full translation
 * of every Yr symbol code belongs with Phase 8's actual weather page,
 * which needs the same table for its own forecast display and icons --
 * duplicating a partial guess here would just have to be redone there.
 * Anything not in this small table falls back to a humanized version of
 * the raw code (underscores to spaces, day/night/twilight suffix
 * stripped) rather than a translated word.
 */
const SYMBOL_CONDITION_KEYS: Record<string, ParamlessKey> = {
    clearsky: 'symbol.clearsky',
    fair: 'symbol.fair',
    partlycloudy: 'symbol.partlycloudy',
    cloudy: 'symbol.cloudy',
    fog: 'symbol.fog',
    rain: 'symbol.rain',
    lightrain: 'symbol.lightrain',
    heavyrain: 'symbol.heavyrain',
    rainshowers: 'symbol.rainshowers',
    sleet: 'symbol.sleet',
    snow: 'symbol.snow',
    lightsnow: 'symbol.lightsnow',
    heavysnow: 'symbol.heavysnow',
};

function humanizeSymbolCode(symbolCode: string): string {
    const base = symbolCode.replace(/_(day|night|polartwilight)$/, '');
    const key = SYMBOL_CONDITION_KEYS[base];
    if (key) return t(key);
    return base.replace(/_/g, ' ');
}

/** Mounts the bottom-right point-forecast panel (artboard 01) into `container`, re-rendering it from `state` reactively. Returns a disposer. */
export function mountPointForecastPanel(
    container: HTMLElement,
    state: ReadonlySignal<PointForecastState>,
    onRetry: (lat: number, lng: number) => void,
): () => void {
    const panel = document.createElement('div');
    panel.className = 'point-forecast-panel';
    container.append(panel);

    const disposeEffect = effect(() => {
        panel.innerHTML = '';
        const current = state.get();
        if (current.status === 'idle') {
            panel.style.display = 'none';
            return;
        }
        panel.style.display = '';

        const label = document.createElement('div');
        label.className = 'point-forecast-label';
        label.textContent = t('map.pointForecastLabel');
        panel.append(label);

        if (current.status === 'loading') {
            const loading = document.createElement('div');
            loading.className = 'point-forecast-loading';
            loading.textContent = t('map.pointForecastLoading');
            panel.append(loading);
            return;
        }

        if (current.status === 'error') {
            const error = document.createElement('div');
            error.className = 'point-forecast-error';
            error.textContent = t('map.pointForecastError');
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.className = 'point-forecast-retry';
            retry.textContent = t('map.pointForecastRetry');
            retry.addEventListener('click', () => {
                onRetry(current.lat, current.lng);
            });
            panel.append(error, retry);
            return;
        }

        const { weather } = current;
        const temp = document.createElement('div');
        temp.className = 'point-forecast-temp';
        temp.textContent = `${formatNumber(weather.current.temperature.value)}°`;

        const condition = document.createElement('div');
        condition.className = 'point-forecast-condition';
        condition.textContent = t('map.pointForecastCondition', {
            condition: humanizeSymbolCode(weather.current.conditions.symbol_code),
            direction: compassWord(weather.current.wind.direction),
        });

        const stats = document.createElement('div');
        stats.className = 'point-forecast-stats';
        stats.textContent = t('map.pointForecastStats', {
            wind: formatNumber(weather.current.wind.speed, t('unit.metersPerSecond')),
            precip: formatNumber(weather.current.rain.current, t('unit.millimeters')),
            lat: formatNumber(current.lat),
            lng: formatNumber(current.lng),
        });

        panel.append(temp, condition, stats);
    });

    return function dispose(): void {
        disposeEffect();
        panel.remove();
    };
}
