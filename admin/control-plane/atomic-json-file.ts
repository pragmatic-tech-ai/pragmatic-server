import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * `mode` is the temp file's permission bits (omitted: the platform default); `fsync` flushes the temp file before the
 * rename; `onDirectorySyncFailure` is told of a failed parent-directory sync after the rename (omitted: it is ignored).
 */
export type AtomicWriteOptions = { readonly mode?: number; readonly fsync?: boolean; readonly onDirectorySyncFailure?: (err: unknown) => void }

/**
 * Writes a file atomically (JSON via Write, any text via WriteText): the parent directory is created, the text goes to a
 * uniquely named temp file next to the target (`<path>.<uuid>.tmp`), which is then renamed over it. Any failure after the
 * temp file was opened removes it and rethrows the ORIGINAL error (a close failure never replaces it). With `fsync: true`
 * the temp file is synced before the rename and, on POSIX only, the parent directory is synced after it, so the rename
 * itself survives a crash (directory fsync is unsupported on Windows and is skipped there). The directory sync is best
 * effort: once the rename succeeded the new content is already in place, so a failed directory sync never rejects the
 * write. It goes to `onDirectorySyncFailure` when one is given (a throwing callback is ignored) and is ignored otherwise.
 * Node built-ins only, so the in-hive console's dependency-light code may use it.
 */
export class AtomicJsonFile
{
    private static readonly TempSuffix = '.tmp'
    private static readonly Utf8 = 'utf8'

    private static readonly OpenFlags = 'w'
    private static readonly ReadFlags = 'r'
    private static readonly WindowsPlatform = 'win32'

    /** `indent` is passed to JSON.stringify (omitted: compact). */
    public static Write(path: string, value: unknown, indent?: number, options?: AtomicWriteOptions): Promise<void>
    {
        return AtomicJsonFile.WriteText(path, JSON.stringify(value, null, indent), options)
    }

    /** The text goes out as given; the same temp-then-rename dance, with the temp file's mode and an fsync before the rename when asked. */
    public static async WriteText(path: string, text: string, options?: AtomicWriteOptions): Promise<void>
    {
        await mkdir(dirname(path), { recursive: true })
        const temp = `${path}.${randomUUID()}${AtomicJsonFile.TempSuffix}`
        const handle = await open(temp, AtomicJsonFile.OpenFlags, options?.mode)
        try
        {
            try
            {
                await handle.writeFile(text, AtomicJsonFile.Utf8)
                if (options?.fsync === true)
                {
                    await handle.sync()
                }
            }
            catch (err)
            {
                // Best-effort close: the write/sync error is the cause the caller must see.
                await handle.close().catch(() => undefined)
                throw err
            }
            await handle.close()
            await rename(temp, path)
        }
        catch (err)
        {
            await unlink(temp).catch(() => undefined)
            throw err
        }
        if (options?.fsync === true && process.platform !== AtomicJsonFile.WindowsPlatform)
        {
            await AtomicJsonFile.SyncDirectoryBestEffort(dirname(path), options.onDirectorySyncFailure)
        }
    }

    /**
     * Runs `sync` (the real directory fsync by default) on `directory` and never rejects: a failure goes to `onFailure` when
     * given (a throwing `onFailure` is ignored) and is ignored otherwise. `sync` is a seam for tests on every platform.
     */
    public static async SyncDirectoryBestEffort(directory: string, onFailure: ((err: unknown) => void) | undefined, sync: (directory: string) => Promise<void> = AtomicJsonFile.SyncDirectory): Promise<void>
    {
        try
        {
            await sync(directory)
        }
        catch (err)
        {
            try
            {
                onFailure?.(err)
            }
            catch
            {
                // The write already landed; a failing report must not turn it into a rejection.
            }
        }
    }

    private static async SyncDirectory(directory: string): Promise<void>
    {
        const handle = await open(directory, AtomicJsonFile.ReadFlags)
        try
        {
            await handle.sync()
        }
        finally
        {
            await handle.close()
        }
    }
}

/**
 * Runs async work one call at a time, in call order. Each run starts after every earlier one settled; a failure reaches
 * only its own caller and never stalls the runs after it. Dependency-free.
 */
export class SerialRuns
{
    private chain: Promise<void> = Promise.resolve()

    public Run<T>(work: () => Promise<T>): Promise<T>
    {
        const run = this.chain.then(work)
        this.chain = run.then(() => undefined, () => undefined)
        return run
    }
}
