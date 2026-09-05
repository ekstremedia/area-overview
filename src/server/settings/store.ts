/**
 * Persists `Settings` to a JSON file on disk. This is the only write
 * surface in the whole app, so its failure modes are deliberately narrow
 * and boring:
 *
 *  - missing file -> in-memory defaults, writes allowed.
 *  - corrupt file (unparseable JSON, or JSON that fails schema
 *    validation) -> in-memory defaults so `GET /api/settings` keeps
 *    working, but every write is refused with `SettingsWritesRefusedError`
 *    until a human fixes the file by hand and restarts the process. There
 *    is deliberately no repair-in-place: the app must never guess at a
 *    fix and silently overwrite a file a human needs to look at.
 *  - a failed write (e.g. a failed `rename`) never touches the file
 *    that was already on disk: the new content is written to a `.tmp`
 *    sibling first and only `rename`d over the real path once it is
 *    fully flushed, so a crash or failure mid-write leaves the previous
 *    file (or nothing extra) -- never a truncated/partial one.
 */
import { mkdir as fsMkdir, readFile as fsReadFile, rename as fsRename, writeFile as fsWriteFile } from 'node:fs/promises';
import path from 'node:path';
import { SettingsSchema, type Placement, type Settings, type SettingsPatch } from '../../shared/schemas/settings.js';

export class SettingsWritesRefusedError extends Error {
    constructor(reason: string) {
        super(`Settings writes are refused: ${reason}`);
        this.name = 'SettingsWritesRefusedError';
    }
}

export interface SettingsStoreLogger {
    error: (message: string) => void;
}

/** The subset of `node:fs/promises` this store needs, injectable so tests can simulate a failing `rename` without touching real disk permissions. */
export interface SettingsStoreFs {
    readFile: typeof fsReadFile;
    writeFile: typeof fsWriteFile;
    rename: typeof fsRename;
    mkdir: typeof fsMkdir;
}

const defaultFs: SettingsStoreFs = { readFile: fsReadFile, writeFile: fsWriteFile, rename: fsRename, mkdir: fsMkdir };

const KNOWN_TOP_LEVEL_KEYS = new Set(Object.keys(SettingsSchema.shape));

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error;
}

/**
 * Splits a raw parsed JSON value into its schema-known settings and any
 * top-level keys the schema doesn't recognise. Zod's default parsing
 * silently *strips* unknown keys -- correct for validation, but it would
 * silently drop those keys the next time this store writes the file. So
 * unknown top-level keys are captured here (never validated, never
 * merged into the typed `Settings` value) and spliced back onto the
 * output verbatim on every write, alongside the known keys. This only
 * covers *top-level* keys: nested schemas (`homeView`, `night`, `ships`,
 * `aircraft`) still strip their own unknown sub-keys, which is an
 * accepted, narrower scope for "unknown keys are preserved".
 */
function extractUnknownTopLevelKeys(raw: unknown): Record<string, unknown> {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return {};
    }
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
            extra[key] = value;
        }
    }
    return extra;
}

export class SettingsStore {
    private readonly filePath: string;
    private readonly tmpPath: string;
    private readonly logger: SettingsStoreLogger;
    private readonly fs: SettingsStoreFs;

    private settings: Settings = SettingsSchema.parse({});
    private unknownTopLevelKeys: Record<string, unknown> = {};
    private writesRefusedReason: string | null = null;

    /**
     * Every write (`patch`, `setPlacement`) is chained onto this single
     * promise so writes run strictly one at a time, in call order. Each
     * queued step reads `this.settings` only when it actually *runs* (never
     * a value captured earlier when it was enqueued), so under concurrent
     * calls the second step to run always merges on top of the first's
     * already-applied result -- both the in-memory state and the eventual
     * on-disk file end up reflecting every call, never just the last one
     * to finish its own I/O.
     */
    private writeChain: Promise<void> = Promise.resolve();

    constructor(filePath: string, options: { logger?: SettingsStoreLogger; fs?: Partial<SettingsStoreFs> } = {}) {
        this.filePath = path.resolve(process.cwd(), filePath);
        this.tmpPath = `${this.filePath}.tmp`;
        this.logger = options.logger ?? console;
        this.fs = { ...defaultFs, ...options.fs };
    }

    async load(): Promise<void> {
        let raw: string;
        try {
            raw = await this.fs.readFile(this.filePath, 'utf8');
        } catch (error) {
            if (isNodeError(error) && error.code === 'ENOENT') {
                this.settings = SettingsSchema.parse({});
                this.unknownTopLevelKeys = {};
                this.writesRefusedReason = null;
                return;
            }
            this.refuse(`could not read settings file "${this.filePath}": ${String(error)}`);
            return;
        }

        let parsedJson: unknown;
        try {
            parsedJson = JSON.parse(raw);
        } catch {
            this.refuse(`settings file "${this.filePath}" is not valid JSON`);
            return;
        }

        const result = SettingsSchema.safeParse(parsedJson);
        if (!result.success) {
            this.refuse(`settings file "${this.filePath}" failed schema validation: ${result.error.message}`);
            return;
        }

        this.settings = result.data;
        this.unknownTopLevelKeys = extractUnknownTopLevelKeys(parsedJson);
        this.writesRefusedReason = null;
    }

    /** The current in-memory settings. Assumes `load()` has already run at boot. */
    get(): Settings {
        return this.settings;
    }

    async patch(p: SettingsPatch): Promise<Settings> {
        return this.enqueueWrite(async () => {
            this.assertWritable();
            const previous = this.settings;
            // `SettingsPatch`'s keys are all optional (it's `.partial()`),
            // so TS can't statically see that a spread of it only ever
            // overwrites keys with defined values -- the assertion is safe
            // because every field it *does* carry already passed
            // `SettingsPatchSchema` validation upstream, and every field it
            // omits falls through to `previous`'s already-valid value.
            this.settings = { ...previous, ...p, updatedAt: new Date().toISOString() } as Settings;
            await this.persistOrRollback(previous);
            return this.settings;
        });
    }

    async setPlacement(cameraId: string, placement: Placement | null): Promise<Settings> {
        return this.enqueueWrite(async () => {
            this.assertWritable();
            const previous = this.settings;
            const placements: Settings['placements'] =
                placement === null
                    ? // `Object.entries`/`fromEntries` drops the key without a
                      // dynamic `delete`, which the lint config forbids.
                      Object.fromEntries(Object.entries(previous.placements).filter(([id]) => id !== cameraId))
                    : { ...previous.placements, [cameraId]: placement };
            this.settings = { ...previous, placements, updatedAt: new Date().toISOString() };
            await this.persistOrRollback(previous);
            return this.settings;
        });
    }

    private refuse(reason: string): void {
        this.settings = SettingsSchema.parse({});
        this.unknownTopLevelKeys = {};
        this.writesRefusedReason = reason;
        this.logger.error(`[settings] ${reason} -- serving defaults, refusing writes until fixed`);
    }

    private assertWritable(): void {
        if (this.writesRefusedReason !== null) {
            throw new SettingsWritesRefusedError(this.writesRefusedReason);
        }
    }

    private enqueueWrite<T>(step: () => Promise<T>): Promise<T> {
        const result = this.writeChain.then(step, step);
        // Swallow the outcome for chaining purposes only: a failed write
        // must not permanently wedge every future write behind a
        // never-resolving chain. The real error still propagates to the
        // caller of this specific `patch`/`setPlacement` call via `result`.
        this.writeChain = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    /** Writes the current in-memory `settings`; on any failure, restores `previous` so a partial write never lingers as the visible in-memory state either. */
    private async persistOrRollback(previous: Settings): Promise<void> {
        try {
            await this.persist();
        } catch (error) {
            this.settings = previous;
            throw error;
        }
    }

    private async persist(): Promise<void> {
        const output: Record<string, unknown> = { ...this.unknownTopLevelKeys, ...this.settings };
        const body = JSON.stringify(output, null, 4);

        await this.fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await this.fs.writeFile(this.tmpPath, body, 'utf8');
        await this.fs.rename(this.tmpPath, this.filePath);
    }
}
