/**
 * A token bucket bounding how often this process calls some outbound
 * service, no matter how many visitors are asking.
 *
 * The ADS-B aggregators are free community services with no published
 * quota and no API key -- nothing stops this app from hammering them
 * except this app. While there was one kiosk, the per-bbox cache was that
 * limit: one viewport, one request per cache TTL. On the public internet
 * the bbox is attacker-controlled in effect, since every visitor brings
 * their own viewport and every pan makes a new one, so the request rate
 * scales with people rather than with anything we chose.
 *
 * A bucket rather than a bare minimum interval (which is what the OpenSky
 * gate in `aircraft/provider.ts` uses) because a real pan is bursty: a
 * person drags the map and `moveend` fires several times in a couple of
 * seconds, then nothing for a minute. A flat interval either rejects the
 * burst or has to be set loose enough to permit the sustained rate too.
 * Banking a few tokens during the quiet minute covers the burst while
 * keeping the long-run average at one per `minIntervalMs`.
 *
 * Deliberately NOT per-IP. Per-IP counting is prohibited in this codebase
 * (see `settings/auth.ts`'s header comment -- a previous per-IP ban system
 * took a shared public IP offline, and visitors behind one NAT would be
 * punished for each other). This bounds what *we* send, and it can never
 * block a visitor: when the gate is shut, the aircraft route falls back to
 * its stale cache and then to remembered aircraft, which is the same path
 * an upstream outage already takes.
 */

export interface OutboundGate {
    /**
     * Takes one token if the bucket has one, and says whether it did.
     * Never blocks, never throws, never rejects -- a caller that is
     * refused must degrade, not wait.
     */
    tryTake(nowMs?: number): boolean;
}

export interface OutboundGateOptions {
    /** The long-run average: one token accrues per this many milliseconds. */
    minIntervalMs: number;
    /** How many tokens may be banked for a burst. Defaults to 1, which makes this a plain minimum interval. */
    burst?: number;
}

export function createOutboundGate(options: OutboundGateOptions): OutboundGate {
    const { minIntervalMs } = options;
    const burst = Math.max(1, options.burst ?? 1);

    // Starts full, so a freshly-booted process can serve the first
    // viewport (and the pan that usually follows it) immediately rather
    // than making the first visitor wait out a refill.
    let tokens = burst;
    let lastRefillMs: number | undefined;

    function tryTake(nowMs: number = Date.now()): boolean {
        // A clock that goes backwards -- NTP stepping, a test passing an
        // earlier timestamp -- must not mint tokens or strand the bucket.
        // Treating it as "no time passed" is the conservative reading.
        const elapsedMs = lastRefillMs === undefined ? 0 : Math.max(0, nowMs - lastRefillMs);
        lastRefillMs = nowMs;

        if (elapsedMs > 0) {
            tokens = Math.min(burst, tokens + elapsedMs / minIntervalMs);
        }

        if (tokens < 1) return false;
        tokens -= 1;
        return true;
    }

    return { tryTake };
}
