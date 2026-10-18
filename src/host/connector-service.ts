import type { ConnectorRuntime } from '../connectors/connector-runtime.js'
import type { ConnectorModelDto, ConnectorWriteBackParams, ConnectorPagedWriteParams, ConnectorPagedWriteResultDto, EntityDto, FlushOutcomeDto, Page, PageParams, ConnectionProbeDto, ConnectorRefreshOutcomeDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { PagingLimits } from '../config/paging-limits.js'
import { PageFingerprint, PageRequest } from './paging/page-request.js'
import { WireScalar } from './wire-scalar.js'
import { EntityDtoMapper } from './entity-dto-mapper.js'
import { EntityInstanceView } from './entity-instance-view.js'
import { ConnectorPageReader } from '../connectors/connector-page-reader.js'
import { ConnectorHydrateWriter } from './connector-hydrate-writer.js'
import type { IHydrateAuthorization } from './connector-hydrate-writer.js'
import type { IWriteTargetSource } from './write-target-source.js'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import { ConnectorReadAuthorizations, ConnectorPrincipalDigest } from './connector-read-authorization.js'
import type { IConnectorReadAuthorization } from './connector-read-authorization.js'

/** Per-connection façade over the 6A ConnectorRuntime: lazily holds one runtime (rebuilt on Invalidate, i.e.
 *  connector/refresh or solution/open) and maps engine info shapes to camelCase wire DTOs. Carries names,
 *  node ids, and scalar field values only — never a connection Config or secret. */
export class ConnectorService
{
    private static readonly ConnectorFingerprintTag = 'connector'

    private readonly runtimeFactory: () => Promise<ConnectorRuntime>
    private runtimePromise: Promise<ConnectorRuntime> | undefined
    private readonly authorizationFor: ((target: IWriteTargetSource) => IHydrateAuthorization) | undefined
    private readonly readAuthorizationFor: ((context: AccessContext) => Promise<IConnectorReadAuthorization>) | undefined

    /** authorizationFor (optional) builds the identity authorizer+gate over the KEYED write-target source; absent => allow-all
     *  (the per-method policy gate still guards connector/writePaged). */
    public constructor(runtimeFactory: () => Promise<ConnectorRuntime>, authorizationFor?: (target: IWriteTargetSource) => IHydrateAuthorization, readAuthorizationFor?: (context: AccessContext) => Promise<IConnectorReadAuthorization>)
    {
        this.runtimeFactory = runtimeFactory
        this.authorizationFor = authorizationFor
        this.readAuthorizationFor = readAuthorizationFor
    }

    /** Evicts (targeted, per spec) this connection's connector adapters from the process-wide catalog so the next
     *  open re-resolves credentials, then drops the runtime. Never disposes the whole catalog (other tenants share it). */
    public async Invalidate(): Promise<void>
    {
        const pending = this.runtimePromise
        // Cleared before the awaits on purpose; self-healing. If a concurrent request rebuilds the runtime while we
        // evict, an adapter it reopened is simply evicted/reopened once more on next use (one extra reopen). We
        // deliberately add no locking for that cost.
        this.runtimePromise = undefined
        if (pending === undefined)
        {
            return
        }
        let runtime: ConnectorRuntime
        try
        {
            runtime = await pending
        }
        catch
        {
            return
        }
        const catalog = runtime.Catalog()
        for (const spec of runtime.ConnectorSpecs())
        {
            await catalog.Invalidate(spec)
        }
    }

    private Runtime(): Promise<ConnectorRuntime>
    {
        if (this.runtimePromise === undefined)
        {
            const pending = this.runtimeFactory()
            this.runtimePromise = pending
            pending.catch(() =>
            {
                if (this.runtimePromise === pending)
                {
                    this.runtimePromise = undefined
                }
            })
        }
        return this.runtimePromise
    }

    public async List(): Promise<ConnectorModelDto[]>
    {
        const runtime = await this.Runtime()
        return runtime.ModelsWithConnectors().map((m) => ({
            modelId: m.ModelId,
            connectors: m.Connectors.map((c) => ({ name: c.Name, kind: c.Kind })),
            bindings: m.Bindings.map((b) => ({ concept: b.Concept, connector: b.Connector, source: b.Source, writable: b.Writable })),
        }))
    }

    public async Prepare(modelId: string): Promise<void>
    {
        const runtime = await this.Runtime()
        await runtime.PrepareModel(modelId)
    }

    /** The per-request read authorization (allow-all when no factory is wired). Filtering lands in later tasks. */
    private ReadAuthorization(context: AccessContext): Promise<IConnectorReadAuthorization>
    {
        return this.readAuthorizationFor === undefined ? Promise.resolve(ConnectorReadAuthorizations.AllowAll()) : this.readAuthorizationFor(context)
    }

    public async Read(modelId: string, concept: string, params: PageParams, limits: PagingLimits, context: AccessContext): Promise<Page<EntityDto>>
    {
        PageRequest.ValidatePageSize(params)
        const authz = await this.ReadAuthorization(context)
        const runtime = await this.Runtime()
        const fingerprint = PageFingerprint.Of(ConnectorService.ConnectorFingerprintTag, modelId, concept, runtime.Revision, ConnectorPrincipalDigest.Of(context))
        const page = PageRequest.Resolve(params, fingerprint, limits)
        const all = await runtime.ReadConceptInstances(modelId, concept)
        const visible = all.filter(e => authz.Filter.Keep(new EntityInstanceView(e)))
        const window = visible.slice(page.Offset, page.Offset + page.Size + 1)
        const hasMore = window.length > page.Size
        const items = (hasMore ? window.slice(0, page.Size) : window).map((e) => EntityDtoMapper.FromEntity(e, authz.FieldMask))
        const nextCursor = page.NextCursor(hasMore)
        return nextCursor === undefined ? { items } : { items, nextCursor }
    }

    /** On-demand keyset-paged read of ONE connector binding: never prepares the model nor opens any other concept's adapter. */
    public async ReadPage(modelId: string, concept: string, params: PageParams, limits: PagingLimits, context: AccessContext): Promise<Page<EntityDto>>
    {
        const runtime = await this.Runtime()
        const authz = await this.ReadAuthorization(context)
        void authz
        return new ConnectorPageReader(runtime).ReadPage(modelId, concept, params, limits)
    }

    /** Hydrate-on-write: edits paged entities by id+fields, reconstructing each write target with one keyed read. Never prepares the model. */
    public async WritePaged(params: ConnectorPagedWriteParams): Promise<ConnectorPagedWriteResultDto>
    {
        const runtime = await this.Runtime()
        const plan = runtime.PlanOf(params.modelId)
        // Keyed per-row authorization is wired-but-DORMANT: the handler builds this service without authorizationFor, so allow-all
        // applies (parity with connector/writeBack). The per-row-identity item activates it via authorizationFor over the keyed target.
        const authorization = this.authorizationFor === undefined ? ConnectorHydrateWriter.AllowAll() : this.authorizationFor(ConnectorHydrateWriter.KeyedTarget(plan, runtime))
        return new ConnectorHydrateWriter(plan, runtime, authorization, runtime.SchemaOf(params.modelId)).Apply(params)
    }

    public async WriteBack(params: ConnectorWriteBackParams): Promise<FlushOutcomeDto>
    {
        const runtime = await this.Runtime()
        const outcome = await runtime.WriteBack(params.modelId, params.dirty, params.deleted)
        return {
            results: outcome.Results.map((r) => ({ applied: r.Applied, failures: r.Failures.map((f) => ({ key: WireScalar.Of(f.Key), kind: f.Kind, reason: f.Reason })) })),
            diagnostics: outcome.Diagnostics.map((d) => ({ code: d.code, message: d.message })),
        }
    }

    /** In-place data refresh of one model: adapters stay open, nothing is evicted (unlike Invalidate). With no runtime
     *  built yet there is nothing materialized to refresh, so it is a no-op that never builds one. */
    public async RefreshModel(modelId: string): Promise<ConnectorRefreshOutcomeDto>
    {
        if (this.runtimePromise === undefined)
        {
            return { diagnostics: [] }
        }
        const runtime = await this.Runtime()
        const outcome = await runtime.RefreshModel(modelId)
        return { diagnostics: outcome.Diagnostics.map((d) => ({ code: d.code, message: d.message })) }
    }

    public async Test(modelId: string, connectorName: string): Promise<ConnectionProbeDto>
    {
        const runtime = await this.Runtime()
        const probe = await runtime.TestConnection(modelId, connectorName)
        return probe.Detail === undefined ? { ok: probe.Ok } : { ok: probe.Ok, detail: probe.Detail }
    }
}
