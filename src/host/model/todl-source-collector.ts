import { createHash } from 'node:crypto'
import type { SourceFile } from '@pragmatic-tech-ai/todl'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'

/**
 * Collects a member's `.todl` sources from its storage (server analogue of Plexus
 * collectTodlSources) and hashes them for compare-and-swap concurrency checks.
 */
export class TodlSourceCollector
{
    private static readonly TodlExtension = '.todl'
    private static readonly PathSeparator = '/'
    private static readonly BuildOutputDirs: readonly string[] = ['dist']
    private static readonly HashAlgorithm = 'sha256'
    private static readonly HashEncoding = 'hex'
    private static readonly FieldSeparator = '\u0000'

    /** Every `.todl` file under the storage root, excluding top-level build-output folders. */
    public async Collect(storage: IStorage): Promise<SourceFile[]>
    {
        const out: SourceFile[] = []
        await this.Walk(storage, '', out)
        return out
    }

    /** A stable hash of the sources (order-independent: sorted by uri). */
    public SourceHash(sources: readonly SourceFile[]): string
    {
        const hash = createHash(TodlSourceCollector.HashAlgorithm)
        const sorted = [...sources].sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0))
        for (const source of sorted)
        {
            hash.update(source.uri)
            hash.update(TodlSourceCollector.FieldSeparator)
            hash.update(source.text)
            hash.update(TodlSourceCollector.FieldSeparator)
        }
        return hash.digest(TodlSourceCollector.HashEncoding)
    }

    private async Walk(storage: IStorage, dir: string, out: SourceFile[]): Promise<void>
    {
        for (const entry of await storage.List(dir))
        {
            if (dir === '' && entry.IsDirectory && TodlSourceCollector.BuildOutputDirs.includes(entry.Name)) continue
            const path = dir === '' ? entry.Name : dir + TodlSourceCollector.PathSeparator + entry.Name
            if (entry.IsDirectory)
            {
                await this.Walk(storage, path, out)
            }
            else if (entry.Name.toLowerCase().endsWith(TodlSourceCollector.TodlExtension))
            {
                out.push({ uri: path, text: await storage.ReadText(path) })
            }
        }
    }
}
