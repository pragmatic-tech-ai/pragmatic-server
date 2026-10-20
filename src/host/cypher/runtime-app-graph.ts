import type { StoragePackageSource } from '@pragmatic-tech-ai/todl'
import { Domain } from '@pragmatic-tech-ai/todl/domain'
import { GraphQuery, type IGraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import type { PragmaticAppManifest, PragmaticAppPackageRef } from '../apps/pragmatic-app-manifest.js'

/** Composes published packages into one queryable graph via the Domain resolver. */
export class RuntimeAppGraph
{
    /** Loads every package ref into a fresh Domain (the single home for the load loop). */
    public static async BuildDomainFromPackages(source: StoragePackageSource, refs: readonly PragmaticAppPackageRef[]): Promise<Domain>
    {
        const domain = new Domain(source)
        for (const ref of refs)
        {
            await domain.load({ model: ref.id, version: ref.version })
        }
        return domain
    }

    public static async BuildQueryFromPackages(source: StoragePackageSource, refs: readonly PragmaticAppPackageRef[]): Promise<IGraphQuery>
    {
        return new GraphQuery((await RuntimeAppGraph.BuildDomainFromPackages(source, refs)).graph)
    }

    /** Loads every manifest package into a fresh Domain. */
    public static async BuildDomain(source: StoragePackageSource, manifest: PragmaticAppManifest): Promise<Domain>
    {
        return RuntimeAppGraph.BuildDomainFromPackages(source, manifest.packages)
    }

    public static async BuildQuery(source: StoragePackageSource, manifest: PragmaticAppManifest): Promise<IGraphQuery>
    {
        return new GraphQuery((await RuntimeAppGraph.BuildDomain(source, manifest)).graph)
    }
}
