import { randomUUID } from 'node:crypto'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Writes a JSON file atomically: the parent directory is created, the text goes to a uniquely named temp file next to the
 * target (`<path>.<uuid>.tmp`), which is then renamed over it; a failed rename removes the temp file and rethrows. Node
 * built-ins only, so the in-hive console's dependency-light code may use it.
 */
export class AtomicJsonFile
{
    private static readonly TempSuffix = '.tmp'
    private static readonly Utf8 = 'utf8'

    /** `indent` is passed to JSON.stringify (omitted: compact). */
    public static async Write(path: string, value: unknown, indent?: number): Promise<void>
    {
        await mkdir(dirname(path), { recursive: true })
        const temp = `${path}.${randomUUID()}${AtomicJsonFile.TempSuffix}`
        await writeFile(temp, JSON.stringify(value, null, indent), AtomicJsonFile.Utf8)
        try
        {
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
