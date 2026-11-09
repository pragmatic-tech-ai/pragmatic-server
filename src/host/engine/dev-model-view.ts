import type { GraphEngine, GraphReader, ISubscription } from '@pragmatic-tech-ai/graph'
import { ErrorCodes, ResponseError } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { ModelViewPageDto, PageParams } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { Node, Repository } from '@pragmatic-tech-ai/todl'
import { TodlNames } from '@pragmatic-tech-ai/todl/engine'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import type { IDisposable, IStorage } from '@pragmatic-tech-ai/todl-runtime'
import type { PagingLimits } from '../../config/paging-limits.js'
import type { IMemberReadGate } from '../model-member-builder.js'
import { ModelProjection } from '../model-read-filter.js'
import type { IModelNodeGate } from '../model-read-filter.js'
import { PageFingerprint, PageRequest } from '../paging/page-request.js'
import type { IDevScope, IDevScopeSource } from './dev-access-scope-source.js'
import type { IDevGraphEngine } from './dev-graph-engine-host.js'

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

/** Where model/view's STRUCTURE comes from: the language service (unsaved buffers included), as before the engine. */
export interface IDevModelStructure
{
    ModelView(storage: IStorage): Promise<{ readonly model: Repository; readonly provenanceOf: ReadonlyMap<string, string> } | undefined>
    readonly GraphRevision: number
}

/** The page a model/view asks for: the wire paging params and the connection's paging limits. */
export interface IDevModelViewPage
{
    readonly Params: PageParams
    readonly Limits: PagingLimits
}

/** The dev `model/view` and `model/resources` visibility on the dev graph engine. */
export interface IDevModelView
{
    Page(context: AccessContext, memberId: string | undefined, page: IDevModelViewPage): Promise<ModelViewPageDto>
    /** True when the active solution holds `nodeId` and the caller's scope hides it (false for an unknown id). */
    Hidden(context: AccessContext, nodeId: string): Promise<boolean>
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
 * The visible-instance sets of the latest engine state (schema version and commit), one per scope digest. A read at
 * another state drops them all; so does the host's `Changed` (an applied upgrade).
 */
class VisibleInstanceCache
{
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
        if (visible === undefined)
        {
            const built = VisibleInstances.Of(reader, root)
            visible = built
            this.byDigest.set(digest, built)
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
 * Maps the engine's answer for one caller onto the language-service structure. An INSTANCE (a typed, non-class node)
 * is kept iff the engine shows it to the scope with the same concept; terms and classes (typed class nodes) and
 * untyped nodes (schema, models, policies) are kept, as before. A kept instance's fields are masked by the scope's
 * hidden members for its concept (`GraphReader.HiddenMembers`, which includes HiddenExact); a typed non-instance is
 * masked by its type's hidden members when the engine knows that concept, else all its fields are masked (fail-closed).
 *
 * Unsaved buffers: the structure may hold an instance the saved snapshot lacks (or whose concept the buffer changed).
 * Such an instance is hidden unless the scope restricts no read (no identity and no policy), where it is visible as
 * before: visibility of unsaved edits is never guessed.
 */
class EngineModelGate implements IModelNodeGate, IMemberReadGate
{
    public constructor(private readonly reader: GraphReader, private readonly visible: VisibleInstances)
    {
    }

    public Keeps(node: Node): boolean
    {
        if (!EngineModelGate.IsInstance(node) || this.visible.Unrestricted) return true
        return this.visible.ConceptOf(node.id) === node.type
    }

    public CanRead(node: Node, field: string): boolean
    {
        if (node.type === null || this.visible.Unrestricted) return true
        const hidden = this.HiddenOf(node.type)
        return hidden !== undefined && !hidden.has(field)
    }

    /** The members the scope hides on `concept`; undefined when the engine does not know it as a concept. */
    private HiddenOf(concept: string): ReadonlySet<string> | undefined
    {
        const catalog = this.reader.Catalog
        if (!catalog.Has(concept) || catalog.IsAspect(concept)) return undefined
        return this.reader.HiddenMembers(concept)
    }

    private static IsInstance(node: Node): boolean
    {
        return node.type !== null && !node.isClass
    }
}

/** The engine state one read ran at, with the gate built from it. */
class EngineRead
{
    public constructor(public readonly Version: string, public readonly Commit: bigint, public readonly Scope: IDevScope, public readonly Gate: EngineModelGate)
    {
    }
}

/**
 * The dev tenant's `model/view` and `model/resources` visibility (PragmaticServer.DevModelView()). STRUCTURE comes from
 * the language service as before (nodes, attrs, edges, provenance, unsaved buffers included); instance VISIBILITY and
 * attribute MASKING come from the caller's engine scope (DevAccessScopeSource: TODL policies AND, with identity, access
 * depth and field security), read off the saved engine snapshot. The endpoint decides nothing beyond mapping the
 * engine's answer onto the structure (EngineModelGate); paging, edges and provenance are ModelProjection's, shared with
 * the runtime path.
 *
 * - Page: no active solution / unknown member -> InvalidRequest; a non-positive page size -> InvalidParams. Cursor
 *   fingerprint = `modelView`, member id, `GraphRevision` (read once the view is in hand), engine schema version,
 *   engine commit, scope digest: a cursor is stale after any structure edit, upgrade or commit, and for another caller.
 * - Hidden: the first member whose structure resolves the id decides; an unknown id is not hidden.
 * - The visible-instance set (a `todl.Element` scan) is cached per scope digest for the latest engine state and
 *   dropped on the host's `Changed`. A read that saw the engine upgrade is repeated (`MaxAttempts`).
 */
export class DevModelView implements IDevModelView, IDisposable
{
    public static readonly MaxAttempts = 5
    public static readonly NoActiveSolutionError = 'no active solution after open'
    public static readonly UnknownMemberError = 'unknown solution member'
    private static readonly FingerprintTag = 'modelView'

    private readonly cache = new VisibleInstanceCache()
    private readonly subscription: ISubscription

    public constructor(
        private readonly host: IDevGraphEngine,
        private readonly scopes: () => Promise<IDevScopeSource>,
        private readonly solution: () => Promise<IDevModelSolution | undefined>,
        private readonly structure: () => Promise<IDevModelStructure>)
    {
        this.subscription = host.Changed.Subscribe(() => this.cache.Clear())
    }

    public async Page(context: AccessContext, memberId: string | undefined, page: IDevModelViewPage): Promise<ModelViewPageDto>
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

    public dispose(): void
    {
        this.subscription.dispose()
        this.cache.Clear()
    }

    /** Runs `work` under one reader of the caller's scope at one engine version (repeated when the engine upgrades). */
    private async Read<T>(context: AccessContext, work: (read: EngineRead) => T): Promise<T>
    {
        for (let attempt = 0; attempt < DevModelView.MaxAttempts; attempt++)
        {
            const engine = await this.host.Engine()
            const version = engine.SchemaVersion
            const scope = await (await this.scopes()).ScopeFor(context)
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
                return work(new EngineRead(version, reader.SnapshotCommit, scope, new EngineModelGate(reader, visible)))
            }
            finally
            {
                reader.dispose()
            }
        }
        throw new DevModelViewError(DevModelViewErrorCode.Unsettled)
    }

    private static Moved(engine: GraphEngine, version: string): boolean
    {
        return engine.SchemaVersion !== version
    }
}
