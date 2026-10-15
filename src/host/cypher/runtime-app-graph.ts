import type { StoragePackageSource } from '@pragmatic-tech-ai/todl'
import { Domain } from '@pragmatic-tech-ai/todl/domain'
import { GraphQuery, type IGraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import type { PragmaticAppManifest } from '../apps/pragmatic-app-manifest.js'

/** Composes an application's published packages into one queryable graph via the Domain resolver. */
export class RuntimeAppGraph
{
    /** Loads every manifest package into a fresh Domain. */
    public static async BuildDomain(source: StoragePackageSource, manifest: PragmaticAppManifest): Promise<Domain>
    {
        const domain = new Domain(source)
        for (const pkg of manifest.packages)
        {
            await domain.load({ model: pkg.id, version: pkg.version })
        }
        return domain
    }

    public static async BuildQuery(source: StoragePackageSource, manifest: PragmaticAppManifest): Promise<IGraphQuery>
    {
        return new GraphQuery((await RuntimeAppGraph.BuildDomain(source, manifest)).graph)
    }
}
