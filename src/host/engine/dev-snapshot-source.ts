import { ConnectorPlanEmitter } from '@pragmatic-tech-ai/todl'
import type { Diagnostic, ModelConnectorPlan, NodeId, Repository, TodlDocument } from '@pragmatic-tech-ai/todl'
import { EngineCellMapper, ExternalCatalogDescriber, SavedModelCompiler, TodlNames } from '@pragmatic-tech-ai/todl/engine'
import type { ISavedModel, ISnapshotDescription } from '@pragmatic-tech-ai/todl/engine'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import type { IDevLanguageService } from './dev-language-service.js'
import type { IDevSolution } from './dev-solution.js'
import type { IEngineSnapshot } from './graph-engine-host.js'
import { SavedMember, SavedMemberReader } from './saved-member-reader.js'

/**
 * The engine description of the saved solution, with the repository it was compiled from, the compile's diagnostics
 * (an error means the saved sources do not compile, for example a commit only half on disk), the mapper that
 * renders the engine's Cypher cells in TODL's wire shape against the same compiled metadata, and `Models`: the model
 * ids the compile accepted (one package each, with or without instances), sorted, without the solution package.
 * `Connectors` are the external connector plans the description binds (one per datasource a model populates from,
 * sorted by name) and `Identity` the public ids and keys of their records (ruling S18).
 */
export type DevSnapshot = ISnapshotDescription & IEngineSnapshot & { Repository: Repository; CompileDiagnostics: readonly Diagnostic[] }

/** What a snapshot was compiled from: the solution (identity and name) and each member's storage, source hash and
 *  bases fingerprint (content, not identity). Equal keys compile to the same snapshot. */
class SnapshotKey
{
    private readonly name: string | undefined

    public constructor(private readonly solution: IDevSolution | undefined, private readonly members: readonly SavedMember[])
    {
        this.name = solution?.Name
    }

    public Equals(other: SnapshotKey): boolean
    {
        if (this.solution !== other.solution || this.name !== other.name || this.members.length !== other.members.length) return false
        return this.members.every((member, at) => SnapshotKey.SameMember(member, other.members[at]!))
    }

    private static SameMember(a: SavedMember, b: SavedMember): boolean
    {
        return a.Storage === b.Storage && a.SourceHash === b.SourceHash && a.BasesHash === b.BasesHash
    }
}

/**
 * The dev tenant's engine snapshot: every member's SAVED `.todl` sources (never unsaved editor buffers) compiled by
 * `SavedModelCompiler` into one package per model id, described by TODL's `ExternalCatalogDescriber` (ruling S18) with
 * the `.todl` file connector as both the default and the local connector, and each accepted model's connector plan
 * (`ConnectorPlanEmitter.PlanFor`, re-keyed to the model's package id, delivered by the solution). External bindings
 * are emitted, so a concept a model populates from a datasource is bound to that datasource's engine connector.
 * `Description.Version` is the description's content digest, so a snapshot changes exactly when saved content does.
 * A plan set the environment rules reject (TODL's `EnvironmentCatalogError`, e.g. two models binding one source)
 * fails `Current()` with that error; nothing is cached, so the next call after a save describes again.
 */
export class DevSnapshotSource
{
    /** The solution package name when no solution is open (no models, so nothing it owns). */
    private static readonly NoSolutionName = 'no-solution'

    private readonly reader: SavedMemberReader
    private last: SnapshotKey | undefined
    private lastSnapshot: DevSnapshot | undefined

    public constructor(private readonly solution: () => Promise<IDevSolution | undefined>, languageService: IDevLanguageService, reader?: SavedMemberReader)
    {
        this.reader = reader ?? new SavedMemberReader(languageService)
    }

    /**
     * The snapshot of what is saved now. When the solution, every member's source hash and its resolved bases' content
     * fingerprint are those of the previous call, the previous snapshot is returned without recompiling (a change to
     * unsaved buffers only, even with freshly rebuilt sibling bases).
     */
    public async Current(): Promise<DevSnapshot>
    {
        const solution = await this.solution()
        const members: SavedMember[] = []
        for (const candidate of solution?.Members.ToArray() ?? [])
        {
            if (candidate.Storage !== undefined) members.push(await this.reader.Read(candidate.Storage))
        }
        const key = new SnapshotKey(solution, members)
        if (this.lastSnapshot !== undefined && this.last !== undefined && this.last.Equals(key)) return this.lastSnapshot
        const snapshot = this.Compile(solution, members)
        this.last = key
        this.lastSnapshot = snapshot
        return snapshot
    }

    private Compile(solution: IDevSolution | undefined, members: readonly SavedMember[]): DevSnapshot
    {
        if (solution === undefined) return DevSnapshotSource.Describe([], [], DevSnapshotSource.NoSolutionName)
        // A member with no model holds no instances (TODL nests every concrete instance in a model): its schema reaches
        // the members that use it through their bases. Every member with a model is compiled from its own sources.
        const compiled = members.filter(member => member.Models.length > 0)
        const models: ISavedModel[] = []
        for (const member of compiled)
        {
            const sources = member.AbsoluteSources()
            for (const model of member.Models)
            {
                models.push({ ModelId: model, Namespace: SavedMemberReader.NamespaceOf(model, solution.Name), Sources: sources })
            }
        }
        return DevSnapshotSource.Describe(models, DevSnapshotSource.BasesOf(members, new Set(compiled.map(member => member.Storage))), solution.Name)
    }

    private static Describe(models: readonly ISavedModel[], bases: readonly TodlDocument[], solutionName: string): DevSnapshot
    {
        const saved = SavedModelCompiler.Compile(models, bases, solutionName)
        const accepted = DevSnapshotSource.ModelsOf(saved.Snapshot.manifests, solutionName)
        const catalog = ExternalCatalogDescriber.Describe(saved.Snapshot, DevSnapshotSource.PlansOf(saved.Repository, accepted), {
            DefaultConnector: TodlNames.FileConnector,
            LocalConnector: TodlNames.FileConnector,
            Deliveries: new Map(accepted.map(model => [model, [solutionName]])),
        })
        return {
            Description: catalog.Description,
            External: catalog.External,
            Diagnostics: catalog.Diagnostics,
            Repository: saved.Repository,
            CompileDiagnostics: saved.Diagnostics,
            CellMapper: new EngineCellMapper(saved.Snapshot),
            Models: accepted,
            Connectors: catalog.Connectors,
            Identity: catalog.Identity,
        }
    }

    /**
     * Each accepted model's connector plan, its `Model` re-keyed from the TODL declaration name the emitter gives to the
     * model's package id (the seed Owner id the describer binds by); a model with no population has none.
     */
    private static PlansOf(repository: Repository, models: readonly string[]): ModelConnectorPlan[]
    {
        const plans: ModelConnectorPlan[] = []
        for (const model of models)
        {
            const plan = ConnectorPlanEmitter.PlanFor(repository, model as NodeId)
            if (plan !== undefined) plans.push({ ...plan, Model: model })
        }
        return plans
    }

    /** The compiled packages' model ids (SavedModelCompiler binds one per accepted model id), without the solution's. */
    private static ModelsOf(manifests: readonly { readonly model: string }[], solutionName: string): string[]
    {
        return [...new Set(manifests.map(manifest => manifest.model).filter(model => model !== solutionName))].sort()
    }

    /**
     * Every member's bases, without the nodes compiled from a member that is itself compiled here: its own saved
     * sources declare them (the language service may compile an open sibling from what it holds, and a node declared
     * twice cannot load).
     */
    private static BasesOf(members: readonly SavedMember[], compiled: ReadonlySet<IStorage>): TodlDocument[]
    {
        const bases: TodlDocument[] = []
        const seen = new Set<TodlDocument>()
        for (const member of members)
        {
            for (const base of member.Bases)
            {
                if (seen.has(base)) continue
                seen.add(base)
                const nodes = base.nodes.filter(node => !SavedMember.FromMember(member.OriginOf.get(node.id), compiled))
                if (nodes.length === base.nodes.length)
                {
                    bases.push(base)
                    continue
                }
                // Only edges touching a removed node go: an edge to another base's node stays (bases hold dangling ids).
                const kept = new Set(nodes.map(node => node.id))
                const removed = new Set(base.nodes.filter(node => !kept.has(node.id)).map(node => node.id))
                bases.push({ ...base, nodes, edges: base.edges.filter(edge => !removed.has(edge.from) && !removed.has(edge.to)) })
            }
        }
        return bases
    }
}
