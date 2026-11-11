import { GraphError, GraphErrorCode } from '@pragmatic-tech-ai/graph'
import type { GraphEngine, GraphReader, ISubscription, MemberDef } from '@pragmatic-tech-ai/graph'
import { ErrorCodes, ResponseError } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { ModelViewPageDto, ResolvedResourceDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { Node, Repository } from '@pragmatic-tech-ai/todl'
import { SnapshotDescriber, TodlNames } from '@pragmatic-tech-ai/todl/engine'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import type { IDisposable, IStorage } from '@pragmatic-tech-ai/todl-runtime'
import { StructuredLogger } from '../../observability/logger.js'
import type { ILogger } from '../../observability/logger.js'
import type { IMemberReadGate } from '../model-member-builder.js'
import { ModelProjection } from '../model-projection.js'
import type { IModelNodeGate } from '../model-projection.js'
import { PageFingerprint, PageRequest } from '../paging/page-request.js'
import type { IGraphScope, IGraphScopeSource } from './access-scope-source.js'
import type { IDevGraphEngine } from './dev-graph-engine-host.js'
import type { IGraphModelView, IModelViewPage } from './graph-model-view.js'

/** One member of the active solution as model/view finds it: the wire member id (`Ref.path`) and its storage. */
export interface IDevModelMember
{
    readonly Ref: { readonly path: string }
    readonly Storage?: IStorage
}

/** The active solution slice model/view reads (TODL's `Solution` satisfies it). */
export interface IDevModelSolution
{
    readonly Members: { ToArray(): readonly IDevModelMember[] }
}

/** One resource the language service resolves for a node (TODL's `ResolvedResource` satisfies it). */
export interface IDevModelResource
{
    readonly annotation: string
    readonly path: string
    readonly storage: { readonly Root: string }
}

/** Where model/view's STRUCTURE comes from: the language service (unsaved buffers included), as before the engine. */
export interface IDevModelStructure
{
    ModelView(storage: IStorage): Promise<{ readonly model: Repository; readonly provenanceOf: ReadonlyMap<string, string> } | undefined>
    Resources(nodeId: string): Promise<readonly IDevModelResource[]>
    readonly GraphRevision: number
}

/** Where the model view's diagnostics go (a node the engine refused to judge, hidden fail-closed). */
export interface IDevModelViewDiagnostics
{
    ModelViewDiagnostic(message: string): void
}

/** Reports each diagnostic as one warning on the server logger. */
export class LoggerDevModelViewDiagnostics implements IDevModelViewDiagnostics
{
    private static readonly Line = 'dev model view: '

    public constructor(private readonly logger: ILogger = StructuredLogger.ToStdout())
    {
    }

    public ModelViewDiagnostic(message: string): void
    {
        this.logger.Warn(LoggerDevModelViewDiagnostics.Line + message)
    }
}

export enum DevModelViewErrorCode
{
    /** The engine kept upgrading while the page was read; a later request reads the settled engine. */
    Unsettled = 1,
}

export class DevModelViewError extends Error
{
    private static readonly ErrorName = 'DevModelViewError'
    private static readonly Messages: Readonly<Record<DevModelViewErrorCode, string>> = {
        [DevModelViewErrorCode.Unsettled]: 'the dev graph engine kept upgrading while the model view was read',
    }

    public constructor(public readonly Code: DevModelViewErrorCode)
    {
        super(DevModelViewError.Messages[Code])
        this.name = DevModelViewError.ErrorName
    }
}

/**
 * The instances one scope sees in one engine state: public id -> engine concept (`ScanNodes('todl.Element')` under
 * the scope, then `ConceptOf`), or every instance when the scope restricts no read.
 */
class VisibleInstances
{
    public static readonly All = new VisibleInstances(undefined)

    private constructor(private readonly concepts: ReadonlyMap<string, string> | undefined)
    {
    }

    public get Unrestricted(): boolean
    {
        return this.concepts === undefined
    }

    public static async Of(reader: GraphReader, root: string): Promise<VisibleInstances>
    {
        const concepts = new Map<string, string>()
        for await (const id of reader.ScanNodes(root))
        {
            const concept = await reader.ConceptOf(id)
            if (concept !== undefined) concepts.set(id, concept)
        }
        return new VisibleInstances(concepts)
    }

    /** The engine concept of a visible instance (undefined: hidden, or not in the saved snapshot at all). */
    public ConceptOf(id: string): string | undefined
    {
        return this.concepts?.get(id)
    }
}

/**
 * The visible-instance sets of the latest engine state (schema version and commit), one per scope digest, at most
 * {@link VisibleInstanceCache.MaxScopes} (least recently used dropped first). A read at another state drops them all;
 * so do the host's `Changed` (an applied upgrade) and the scope source's `Dropped` (a security-model invalidation).
 */
class VisibleInstanceCache
{
    public static readonly MaxScopes = 32
    private static readonly StateSeparator = '\u0000'

    private state: string | undefined
    private readonly byDigest = new Map<string, Promise<VisibleInstances>>()

    public Get(digest: string, version: string, commit: bigint, reader: GraphReader, root: string): Promise<VisibleInstances>
    {
        const state = version + VisibleInstanceCache.StateSeparator + String(commit)
        if (this.state !== state)
        {
            this.Clear()
            this.state = state
        }
        let visible = this.byDigest.get(digest)
        if (visible !== undefined)
        {
            // most recently used last
            this.byDigest.delete(digest)
            this.byDigest.set(digest, visible)
        }
        else
        {
            const built = VisibleInstances.Of(reader, root)
            visible = built
            this.byDigest.set(digest, built)
            if (this.byDigest.size > VisibleInstanceCache.MaxScopes) this.byDigest.delete(this.byDigest.keys().next().value!)
            built.catch(() =>
            {
                if (this.byDigest.get(digest) === built) this.byDigest.delete(digest)
            })
        }
        return visible
    }

    public Clear(): void
    {
        this.byDigest.clear()
        this.state = undefined
    }
}

/**
 * Maps the engine's answer for one caller onto the language-service structure; it decides nothing itself.
 *
 * - Untyped nodes (schema, models, policies) are always kept, as before.
 * - An INSTANCE (a typed node with `isClass` false) is kept iff the engine shows it to the scope with the same concept
 *   (the scope's `ScanNodes('todl.Element')` + `ConceptOf`).
 * - A typed CLASS node (a class, or a taxonomy term: TODL types a term with its taxonomy's represented concept) is not
 *   an engine instance under that concept, so the engine is asked about it as a hypothetical node: `GraphReader.Admits
 *   (node.type, its attrs as seed property values)` (R95; the values converted by TODL `SnapshotDescriber.SeedProperties`).
 *   This is the legacy rule (each typed node judged by its concept's read rules on its own attrs) with the engine's
 *   answer: identity and edge predicates are Unknown there and fail closed, an unknown concept is never admitted.
 * - Fields of a kept typed node are masked by `GraphReader.HiddenMembers(node.type)` (HiddenExact included), for
 *   instances and class nodes alike. A taxonomy term is held by the engine as a `todl.Term` node, but in the
 *   structure it is typed by the represented concept, and the legacy mask asked that concept too, so its attrs are
 *   masked by that concept's hidden members, not by todl.Term's. A typed node whose concept the engine lacks has every
 *   field masked (fail-closed).
 * - Under a scope that restricts no read (no identity) every node is kept and nothing is masked.
 *
 * Unsaved buffers (ruling T8-a): the structure may hold an instance the saved snapshot lacks (or whose concept the
 * buffer changed). Such an instance is hidden unless the scope restricts no read, where it is visible as before:
 * visibility of unsaved edits is never guessed. (Class nodes are judged on their buffer attrs: they are not engine
 * instances, so there is no saved answer to prefer.)
 */
class EngineModelGate implements IModelNodeGate, IMemberReadGate
{
    private static readonly NoMembers: readonly MemberDef[] = []
    private static readonly RefusedPrefix = '"'
    private static readonly RefusedSuffix = '" is hidden: the engine refused its values as a hypothetical node: '

    public constructor(private readonly reader: GraphReader, private readonly visible: VisibleInstances, private readonly diagnostics: IDevModelViewDiagnostics)
    {
    }

    public Keeps(node: Node): boolean
    {
        if (node.type === null || this.visible.Unrestricted) return true
        if (node.isClass) return this.Admits(node, node.type)
        return this.visible.ConceptOf(node.id) === node.type
    }

    /**
     * The engine's answer for a class node. Values the engine itself refuses (SchemaViolation: a string TODL accepts but
     * the engine's value codec does not, such as a lone surrogate in an unsaved buffer) hide the node fail-closed and are
     * reported; any other error is a fault and propagates.
     */
    private Admits(node: Node, concept: string): boolean
    {
        try
        {
            return this.reader.Admits(concept, SnapshotDescriber.SeedProperties(this.MembersOf(concept), node.attrs, node.class))
        }
        catch (error)
        {
            if (!(error instanceof GraphError) || error.GraphCode !== GraphErrorCode.SchemaViolation) throw error
            this.diagnostics.ModelViewDiagnostic(EngineModelGate.RefusedPrefix + node.id + EngineModelGate.RefusedSuffix + error.message)
            return false
        }
    }

    public CanRead(node: Node, field: string): boolean
    {
        if (node.type === null || this.visible.Unrestricted) return true
        return this.IsConcept(node.type) && !this.reader.HiddenMembers(node.type).has(field)
    }

    private MembersOf(concept: string): readonly MemberDef[]
    {
        return this.IsConcept(concept) ? this.reader.Catalog.EffectiveMembers(concept) : EngineModelGate.NoMembers
    }

    private IsConcept(concept: string): boolean
    {
        const catalog = this.reader.Catalog
        return catalog.Has(concept) && !catalog.IsAspect(concept)
    }
}

/** The engine state one read ran at, with the gate built from it. */
class EngineRead
{
    public constructor(public readonly Version: string, public readonly Commit: bigint, public readonly Scope: IGraphScope, public readonly Gate: EngineModelGate)
    {
    }
}

/**
 * The dev tenant's `model/view` and `model/resources` visibility (PragmaticServer.DevModelView()). STRUCTURE comes from
 * the language service as before (nodes, attrs, edges, provenance, unsaved buffers included); instance VISIBILITY and
 * attribute MASKING come from the caller's engine scope (AccessScopeSource under DevScopeRules: with identity, access
 * depth and field security), read off the saved engine snapshot. The endpoint decides nothing beyond mapping the
 * engine's answer onto the structure (EngineModelGate); paging, edges and provenance are ModelProjection's. The runtime
 * counterpart is EnvironmentModelView (ruling S15); both implement {@link IGraphModelView}.
 *
 * - Page: no active solution / unknown member -> InvalidRequest; a non-positive page size -> InvalidParams. Cursor
 *   fingerprint = `modelView`, member id, `GraphRevision` (read once the view is in hand), engine schema version,
 *   engine commit, scope digest: a cursor is stale after any structure edit, upgrade or commit, and for another caller.
 * - Hidden: the first member whose structure resolves the id decides; an unknown id is not hidden.
 * - Resources: the language service's resources of the node, `[]` when Hidden.
 * - The visible-instance set (a `todl.Element` scan) is cached per scope digest for the latest engine state (an LRU of
 *   at most 32 digests) and dropped on the host's `Changed` and the scope source's `Dropped`.
 *   A class node whose values the engine refuses (SchemaViolation) is hidden and reported to
 *   {@link IDevModelViewDiagnostics}. A read that saw the engine upgrade is repeated (`MaxAttempts`).
 */
export class DevModelView implements IGraphModelView, IDisposable
{
    public static readonly MaxAttempts = 5
    public static readonly NoActiveSolutionError = 'no active solution after open'
    public static readonly UnknownMemberError = 'unknown solution member'
    private static readonly FingerprintTag = 'modelView'

    private readonly cache = new VisibleInstanceCache()
    private readonly subscriptions: ISubscription[] = []
    /** The scope source whose `Dropped` the cache follows (subscribed on first use: the source is built lazily). */
    private followed: IGraphScopeSource | undefined
    private followedSubscription: ISubscription | undefined

    public constructor(
        private readonly host: IDevGraphEngine,
        private readonly scopes: () => Promise<IGraphScopeSource>,
        private readonly solution: () => Promise<IDevModelSolution | undefined>,
        private readonly structure: () => Promise<IDevModelStructure>,
        private readonly diagnostics: IDevModelViewDiagnostics = new LoggerDevModelViewDiagnostics())
    {
        this.subscriptions.push(host.Changed.Subscribe(() => this.cache.Clear()))
    }

    public async Page(context: AccessContext, memberId: string | undefined, page: IModelViewPage): Promise<ModelViewPageDto>
    {
        const solution = await this.solution()
        if (solution === undefined)
        {
            throw new ResponseError(ErrorCodes.InvalidRequest, DevModelView.NoActiveSolutionError)
        }
        const member = solution.Members.ToArray().find(m => m.Ref.path === memberId)
        if (member === undefined || member.Storage === undefined)
        {
            throw new ResponseError(ErrorCodes.InvalidRequest, DevModelView.UnknownMemberError)
        }
        PageRequest.ValidatePageSize(page.Params)
        const structure = await this.structure()
        const view = await structure.ModelView(member.Storage)
        if (view === undefined)
        {
            throw new ResponseError(ErrorCodes.InvalidRequest, DevModelView.UnknownMemberError)
        }
        // read the revision only once the view is in hand: acquiring it may itself commit the first build
        const revision = String(structure.GraphRevision)
        return this.Read(context, read =>
        {
            const fingerprint = PageFingerprint.Of(DevModelView.FingerprintTag, member.Ref.path, revision, read.Version, String(read.Commit), read.Scope.Digest)
            const request = PageRequest.Resolve(page.Params, fingerprint, page.Limits)
            const members = new ModelProjection(view.model, read.Gate, read.Gate).Page(view.provenanceOf, request.Offset, request.Size)
            const nextCursor = request.NextCursor(members.HasMore)
            return nextCursor === undefined
                ? { items: members.Items, provenanceOf: members.ProvenanceOf }
                : { items: members.Items, provenanceOf: members.ProvenanceOf, nextCursor }
        })
    }

    public async Hidden(context: AccessContext, nodeId: string): Promise<boolean>
    {
        const solution = await this.solution()
        if (solution === undefined)
        {
            return false
        }
        const structure = await this.structure()
        for (const member of solution.Members.ToArray())
        {
            if (member.Storage === undefined)
            {
                continue
            }
            const view = await structure.ModelView(member.Storage)
            if (view === undefined || view.model.resolve(nodeId) === undefined)
            {
                continue
            }
            return this.Read(context, read => new ModelProjection(view.model, read.Gate, read.Gate).Hidden(nodeId))
        }
        return false
    }

    /** The language service's resources of `nodeId`, or `[]` when the caller's scope hides the node. */
    public async Resources(context: AccessContext, nodeId: string): Promise<ResolvedResourceDto[]>
    {
        if (await this.Hidden(context, nodeId))
        {
            return []
        }
        const resources = await (await this.structure()).Resources(nodeId)
        return resources.map(r => ({ annotation: r.annotation, path: r.path, storageRoot: r.storage.Root }))
    }

    public dispose(): void
    {
        for (const subscription of this.subscriptions.splice(0)) subscription.dispose()
        this.followedSubscription?.dispose()
        this.followedSubscription = undefined
        this.followed = undefined
        this.cache.Clear()
    }

    /** Runs `work` under one reader of the caller's scope at one engine version (repeated when the engine upgrades). */
    private async Read<T>(context: AccessContext, work: (read: EngineRead) => T): Promise<T>
    {
        for (let attempt = 0; attempt < DevModelView.MaxAttempts; attempt++)
        {
            const engine = await this.host.Engine()
            const version = engine.SchemaVersion
            const scope = await this.Follow(await this.scopes()).ScopeFor(context)
            let reader: GraphReader
            try
            {
                reader = await engine.BeginRead(scope.Scope)
            }
            catch (error)
            {
                // a scope compiled for a schema the engine left meanwhile: read again on the new one
                if (DevModelView.Moved(engine, version)) continue
                throw error
            }
            try
            {
                const visible = reader.Scope.ReadsUnrestricted
                    ? VisibleInstances.All
                    : await this.cache.Get(scope.Digest, version, reader.SnapshotCommit, reader, TodlNames.Element)
                if (DevModelView.Moved(engine, version)) continue
                return work(new EngineRead(version, reader.SnapshotCommit, scope, new EngineModelGate(reader, visible, this.diagnostics)))
            }
            finally
            {
                reader.dispose()
            }
        }
        throw new DevModelViewError(DevModelViewErrorCode.Unsettled)
    }

    /** Subscribes the cache to `source.Dropped` once per source; switching to a rebuilt source drops the previous subscription. */
    private Follow(source: IGraphScopeSource): IGraphScopeSource
    {
        if (this.followed !== source)
        {
            this.followedSubscription?.dispose()
            this.followed = source
            this.followedSubscription = source.Dropped.Subscribe(() => this.cache.Clear())
        }
        return source
    }

    private static Moved(engine: GraphEngine, version: string): boolean
    {
        return engine.SchemaVersion !== version
    }
}
