import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

/** `mode` is the temp file's permission bits (omitted: the platform default); `fsync` flushes the temp file before the rename. */
export type AtomicWriteOptions = { readonly mode?: number; readonly fsync?: boolean }

/**
 * Writes a JSON file atomically: the parent directory is created, the text goes to a uniquely named temp file next to the
 * target (`<path>.<uuid>.tmp`), which is then renamed over it; a failed rename removes the temp file and rethrows. Node
 * built-ins only, so the in-hive console's dependency-light code may use it.
 */
export class AtomicJsonFile
{
    private static readonly TempSuffix = '.tmp'
    private static readonly Utf8 = 'utf8'

    private static readonly OpenFlags = 'w'

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
            finally
            {
                await handle.close()
            }
            await rename(temp, path)
        }
        catch (err)
        {
            await unlink(temp).catch(() => undefined)
            throw err
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
