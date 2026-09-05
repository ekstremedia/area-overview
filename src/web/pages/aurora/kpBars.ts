/**
 * The eight Kp bars on the aurora page (artboard 03): the three most
 * recent past values, "now" (the actual instantaneous `kpCurrent`
 * reading, not a history-array value), and the four nearest forecast
 * values. A pure function, independent of any resource/DOM state, so it's
 * unit-testable against the real fixture directly.
 */
export interface KpBar {
    value: number;
    kind: 'past' | 'now' | 'future';
}

interface KpPoint {
    time: string;
    kp: number;
}

function byTimeAscending(a: KpPoint, b: KpPoint): number {
    return new Date(a.time).getTime() - new Date(b.time).getTime();
}

export function selectKpBars(kpHistory: readonly KpPoint[], kpCurrentValue: number, kpForecast: readonly KpPoint[], now: Date): KpBar[] {
    const past = kpHistory
        .filter((point) => new Date(point.time).getTime() <= now.getTime())
        .sort(byTimeAscending)
        .slice(-3)
        .map((point): KpBar => ({ value: point.kp, kind: 'past' }));

    const future = kpForecast
        .filter((point) => new Date(point.time).getTime() > now.getTime())
        .sort(byTimeAscending)
        .slice(0, 4)
        .map((point): KpBar => ({ value: point.kp, kind: 'future' }));

    return [...past, { value: kpCurrentValue, kind: 'now' }, ...future];
}
