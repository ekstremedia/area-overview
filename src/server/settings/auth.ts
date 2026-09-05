/**
 * Guards every settings write route (and the login-check route) behind a
 * single shared passphrase. There are no accounts, no sessions, no
 * hashing -- the password lives next to other secrets in `.env` already,
 * and this endpoint is reachable from the open internet with no other
 * auth in front of it, so the two properties that matter are: a wrong
 * guess must not be distinguishable from a missing header by timing, and
 * a flood of guesses must not be able to go faster than one per second.
 *
 * Deliberately absent: any lockout/ban/counter keyed by IP or anything
 * else. A per-IP lockout here would recreate, one layer up in this same
 * codebase, a real incident where an automated ban system took an entire
 * shared public IP offline for an hour after a handful of failed
 * attempts through a hairpinned LAN path. The fixed per-request delay
 * below is the *entire* defense against brute force; it holds no state
 * across requests.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ServerConfig } from '../config.js';

/** The real, production delay on any auth failure. Never reduce this outside of tests. */
export const PRODUCTION_AUTH_FAILURE_DELAY_MS = 1000;

const BEARER_PREFIX = 'Bearer ';

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `crypto.timingSafeEqual` throws if its two buffers differ in length,
 * which would make a wrong-length guess take a different code path (and
 * thus different timing) than a same-length wrong guess -- observable
 * from outside. Hashing both sides to a fixed-length SHA-256 digest
 * first sidesteps that entirely: every input, regardless of its own
 * length, produces a 32-byte digest, so `timingSafeEqual` always runs
 * with equal-length buffers and never takes the throwing branch.
 *
 * Exported so tests can call it directly with mismatched-length inputs
 * and assert it never throws and never takes a different path -- `node:
 * crypto`'s module namespace can't be reliably intercepted with
 * `vi.spyOn`/`vi.mock` across module boundaries, so exercising this
 * function's own behaviour directly is the more reliable way to verify
 * the length-independence property than mocking the underlying primitive.
 */
export function passwordsMatch(expected: string, presented: string): boolean {
    const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
    const presentedDigest = createHash('sha256').update(presented, 'utf8').digest();
    return timingSafeEqual(expectedDigest, presentedDigest);
}

/** Extracts the token from `Authorization: Bearer <token>`. Returns `null` for a missing/malformed/empty header -- never throws. */
export function extractBearerToken(header: string | undefined): string | null {
    if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) {
        return null;
    }
    const token = header.slice(BEARER_PREFIX.length);
    return token.length > 0 ? token : null;
}

/**
 * Builds the Fastify `preHandler` hook. `failureDelayMs` defaults to the
 * real production delay; tests inject a much shorter value so the suite
 * doesn't spend a second per auth test, while a separate test asserts
 * the actual default constant is still 1000ms.
 */
export function requireSettingsPassword(config: ServerConfig, failureDelayMs: number = PRODUCTION_AUTH_FAILURE_DELAY_MS) {
    return async function settingsAuthPreHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
        // `presented` must never be logged, at any level, in this function
        // or anywhere it's passed to -- not its value, not its length, not
        // a hash of it.
        const presented = extractBearerToken(request.headers.authorization);
        const authorized = presented !== null && passwordsMatch(config.settingsPassword, presented);

        if (authorized) {
            return;
        }

        await sleep(failureDelayMs);
        reply.code(401).send({ error: 'Unauthorized' });
    };
}
