import type { Diagnostic, Repository, TodlDocument } from '@pragmatic-tech-ai/todl'
import { SavedModelCompiler, SnapshotDescriber, TodlNames } from '@pragmatic-tech-ai/todl/engine'
import type { ISavedModel, ISnapshotDescription } from '@pragmatic-tech-ai/todl/engine'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import type { IDevLanguageService } from '../model/dev-model-writer.js'
import type { IDevSolution } from './dev-solution.js'
import { SavedMember, SavedMemberReader } from './saved-member-reader.js'

/**
 * The engine description of the saved solution, with the repository it was compiled from and the compile's
 * diagnostics (an error means the saved sources do not compile, for example a commit only half on disk).
 */
export type DevSnapshot = ISnapshotDescription & { Repository: Repository; CompileDiagnostics: readonly Diagnostic[] }

/** What a snapshot was compiled from: the solution (identity and name) and each member's storage, source hash and
 *  resolved bases (by identity). Equal keys compile to the same snapshot. */
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
        return a.Storage === b.Storage && a.SourceHash === b.SourceHash && a.OriginOf === b.OriginOf
            && a.Bases.length === b.Bases.length && a.Bases.every((base, at) => base === b.Bases[at])
    }
}

/**
 * The dev tenant's engine snapshot: every member's SAVED `.todl` sources (never unsaved editor buffers) compiled by
 * `SavedModelCompiler` into one package per model id, described with the `.todl` file connector as the default.
 * `Description.Version` is the description's content digest, so a snapshot changes exactly when saved content does.
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
     * The snapshot of what is saved now. When the solution, every member's source hash and the resolved bases (by
     * identity) are those of the previous call, the previous snapshot is returned without recompiling (a change to
     * unsaved buffers only).
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
        const described = SnapshotDescriber.Describe(saved.Snapshot, { DefaultConnector: TodlNames.FileConnector })
        return { ...described, Repository: saved.Repository, CompileDiagnostics: saved.Diagnostics }
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
