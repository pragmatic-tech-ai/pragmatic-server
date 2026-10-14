import { Repository, toJSON } from '@pragmatic-tech-ai/todl'
import { Domain, MemoryPackageSource, type ResolvedPackage, type SeedGraph, type DomainEdge } from '@pragmatic-tech-ai/todl/domain'
import { GraphQuery, type IGraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import { PackageManifestBridge } from '@pragmatic-tech-ai/todl/package-manager'

/** One tenant model: a legacy Repository plus the model identity its manifest is pinned to. */
export interface TenantRepository
{
    repo: Repository
    model: string
    version: string
}

/** A reflected instance node of the seed graph (the heap node shape). */
export type SeedNode = SeedGraph['nodes'][number]

/**
 * The UNFILTERED, cacheable tenant graph artifact: one schema-only manifest package per
 * repository, plus one merged, id-deduped instance seed across all of them.
 */
export interface TenantGraphArtifact
{
    packages: ResolvedPackage[]
    seedNodes: SeedNode[]
    seedEdges: DomainEdge[]
}

/**
 * Composes a tenant's legacy Repositories into a reflective graph artifact (emit via
 * PackageManifestBridge), then binds it into a Domain/FrozenGraph wrapped as an IGraphQuery.
 *
 * Node-id conflict policy: assert-no-conflict. The same id in two repositories is deduped
 * when the node data is identical, and throws when it differs.
 */
export class TenantGraphComposition
{
    private static readonly NodeConflictMessage = 'Tenant graph node id conflict across repositories: '
    private static readonly DuplicateModelMessage = 'Tenant graph has two repositories pinned to the same model@version: '
    private static readonly IdentitySeparator = '@'

    constructor(private readonly repos: readonly TenantRepository[]) {}

    /** Emit every repository and merge into the unfiltered artifact. */
    public Compose(): TenantGraphArtifact
    {
        const packages: ResolvedPackage[] = []
        const nodes = new Map<string, SeedNode>()
        const edges = new Map<string, DomainEdge>()
        const identities = new Set<string>()
        for (const entry of this.repos)
        {
            const identity = `${entry.model}${TenantGraphComposition.IdentitySeparator}${entry.version}`
            if (identities.has(identity)) throw new Error(TenantGraphComposition.DuplicateModelMessage + identity)
            identities.add(identity)
            const resolved = PackageManifestBridge.toResolvedJsonDocument(toJSON(entry.repo), entry.model, entry.version, [])
            this.MergeSeed(resolved.seed, nodes, edges)
            delete resolved.seed
            packages.push(resolved)
        }
        return { packages, seedNodes: [...nodes.values()], seedEdges: [...edges.values()] }
    }

    /** Load the manifests into a Domain, bind the merged seed, and wrap as a query. */
    public static async BuildQuery(artifact: TenantGraphArtifact): Promise<IGraphQuery>
    {
        const domain = new Domain(new MemoryPackageSource(artifact.packages))
        for (const pkg of artifact.packages) await domain.load(pkg.ref)
        const last = artifact.packages[artifact.packages.length - 1]
        if (last !== undefined && artifact.seedNodes.length > 0)
        {
            // BindSeed mutates nodes (folds edges into refs); clone so the cached artifact stays pristine.
            const seed: SeedGraph = { nodes: structuredClone(artifact.seedNodes), edges: structuredClone(artifact.seedEdges) }
            domain.graph.BindSeed(seed, last.ref)
        }
        return new GraphQuery(domain.graph)
    }

    /** Key-order-independent serialization used to compare node data. */
    private static Canonical(value: unknown): string
    {
        return JSON.stringify(value, (_key, v) =>
        {
            if (v === null || typeof v !== 'object' || Array.isArray(v)) return v
            const sorted: Record<string, unknown> = {}
            for (const k of Object.keys(v as object).sort()) sorted[k] = (v as Record<string, unknown>)[k]
            return sorted
        })
    }

    private MergeSeed(seed: SeedGraph | undefined, nodes: Map<string, SeedNode>, edges: Map<string, DomainEdge>): void
    {
        for (const node of seed?.nodes ?? [])
        {
            const existing = nodes.get(node.id)
            if (existing === undefined) nodes.set(node.id, node)
            else if (TenantGraphComposition.Canonical(existing) !== TenantGraphComposition.Canonical(node)) throw new Error(TenantGraphComposition.NodeConflictMessage + node.id)
        }
        for (const edge of seed?.edges ?? [])
        {
            edges.set(JSON.stringify([edge.from, edge.rel, edge.to]), edge)
        }
    }
}
