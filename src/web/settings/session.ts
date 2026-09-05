/**
 * The client-side half of Phase 3's shared-password login
 * (`POST /api/settings/login`, Bearer-guarded writes). There are no
 * accounts and no server-issued session token -- the password itself
 * *is* the credential, and this module's only job is: hold it in
 * `localStorage` once a login attempt has been confirmed against the
 * server, and hand it back out as an `Authorization` header for every
 * write. There is deliberately no expiry, timer, or idle-based clearing
 * of any kind here -- a logged-in device stays logged in until an
 * explicit `logout()` or a `401` from an actual write (that second path
 * lives in `sharedStore.ts`, not here -- this module is just the storage
 * primitive).
 *
 * The password value itself must never be logged, printed, or included
 * in an error -- not here, not in any module that calls into this one.
 */
import { err, ok, type Result } from '../../shared/result.js';
import { computed, signal, type ReadonlySignal } from '../core/signal.js';

const STORAGE_KEY = 'area-overview:settings-password';

function readStoredPassword(): string | null {
    try {
        return localStorage.getItem(STORAGE_KEY);
    } catch {
        // Storage disabled/unavailable: behave as logged out rather than throw.
        return null;
    }
}

const storedPassword = signal<string | null>(readStoredPassword());

/** Whether this device currently holds a password it believes is valid. Reactive. */
export const isLoggedIn: ReadonlySignal<boolean> = computed(() => storedPassword.get() !== null);

function persist(password: string | null): void {
    storedPassword.set(password);
    try {
        if (password === null) {
            localStorage.removeItem(STORAGE_KEY);
        } else {
            localStorage.setItem(STORAGE_KEY, password);
        }
    } catch {
        // Quota exceeded or storage disabled: the in-memory signal still
        // updated, so the running session behaves correctly; it just won't
        // survive a reload.
    }
}

/**
 * Attempts to log in with `password` against `POST /api/settings/login`.
 * Stores the password (and flips `isLoggedIn`) only on a `204` response.
 * Never stores anything on a `401` or any other failure -- the caller's
 * `err(...)` carries a message safe to display, never the password.
 */
export async function login(password: string): Promise<Result<void>> {
    let response: Response;
    try {
        response = await fetch('/api/settings/login', {
            method: 'POST',
            headers: { Authorization: `Bearer ${password}` },
        });
    } catch (cause) {
        return err({ message: 'Network error while logging in', cause });
    }

    if (response.status === 204) {
        persist(password);
        return ok(undefined);
    }

    if (response.status === 401) {
        return err({ message: 'Wrong password' });
    }

    return err({ message: `POST /api/settings/login responded ${String(response.status)}` });
}

/** Clears the stored password. The only two things that ever call this: an explicit "Log out", and `sharedStore.ts` reacting to a 401 on a write. */
export function logout(): void {
    persist(null);
}

/** `{ Authorization: 'Bearer <password>' }` when logged in, `{}` otherwise. Used by every settings write call. */
export function authHeaders(): Record<string, string> {
    const password = storedPassword.get();
    return password === null ? {} : { Authorization: `Bearer ${password}` };
}
