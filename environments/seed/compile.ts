import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { compilePackage, BlobPackageStore, StoragePackageSink, StoragePackageSource } from '@pragmatic-tech-ai/todl'
import { Domain } from '@pragmatic-tech-ai/todl/domain'
import { GraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'

/** Authors + compiles the Northwind sample application into a package model.json. */
export class NorthwindApp
{
    public static readonly Id = 'northwind'
    public static readonly Version = '1.0.0'
    public static readonly AppName = 'northwind'
    private static readonly SourceUri = 'northwind.todl'
    private static readonly SourcePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'sample-apps', 'northwind', 'northwind.todl')
    private static readonly OrderNoField = 'orderNo'
    private static readonly CompileFailedPrefix = 'northwind compile failed: '

    public static Source(): string
    {
        return readFileSync(NorthwindApp.SourcePath, 'utf8')
    }

    public static async Compile(packagesDir: string): Promise<void>
    {
        const outcome = NorthwindApp.CompileSource()
        if (!outcome.ok || outcome.package === undefined)
        {
            throw new Error(NorthwindApp.CompileFailedPrefix + JSON.stringify(outcome.errors))
        }
        await new BlobPackageStore(new StoragePackageSink(new NodeFsStorage(packagesDir))).persist(outcome.package)
    }

    /** Loads the compiled package from disk into a Domain and counts the instances carrying an order number. */
    public static async QueryOrderCount(packagesDir: string): Promise<number>
    {
        const domain = new Domain(new StoragePackageSource(new NodeFsStorage(packagesDir)))
        await domain.load({ model: NorthwindApp.Id, version: NorthwindApp.Version })
        return new GraphQuery(domain.Snapshot).AllInstances()
            .filter((instance) => instance.field(NorthwindApp.OrderNoField)?.value !== undefined)
            .length
    }

    private static CompileSource(): ReturnType<typeof compilePackage>
    {
        return compilePackage([], [{ uri: NorthwindApp.SourceUri, text: NorthwindApp.Source() }], { id: NorthwindApp.Id, version: NorthwindApp.Version })
    }
}
