import type { ConnectorRuntime } from '../connectors/connector-runtime.js'
import type { ConnectorModelDto, ConnectorWriteBackParams, EntityDto, FlushOutcomeDto, Page, PageParams, ConnectionProbeDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { PagingLimits } from '../config/paging-limits.js'
import { PageFingerprint, PageRequest } from './paging/page-request.js'
import { WireScalar } from './wire-scalar.js'

/** Per-connection façade over the 6A ConnectorRuntime: lazily holds one runtime (rebuilt on Invalidate, i.e.
 *  connector/refresh or solution/open) and maps engine info shapes to camelCase wire DTOs. Carries names,
 *  node ids, and scalar field values only — never a connection Config or secret. */
export class ConnectorService
{
    private static readonly ConnectorFingerprintTag = 'connector'

    private readonly runtimeFactory: () => Promise<ConnectorRuntime>
    private runtimePromise: Promise<ConnectorRuntime> | undefined

    public constructor(runtimeFactory: () => Promise<ConnectorRuntime>)
    {
        this.runtimeFactory = runtimeFactory
    }

    /** Evicts (targeted, per spec) this connection's connector adapters from the process-wide catalog so the next
     *  open re-resolves credentials, then drops the runtime. Never disposes the whole catalog (other tenants share it). */
    public async Invalidate(): Promise<void>
    {
        const pending = this.runtimePromise
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

    public async Read(modelId: string, concept: string, params: PageParams, limits: PagingLimits): Promise<Page<EntityDto>>
    {
        PageRequest.ValidatePageSize(params)
        const runtime = await this.Runtime()
        const fingerprint = PageFingerprint.Of(ConnectorService.ConnectorFingerprintTag, modelId, concept, runtime.Revision)
        const page = PageRequest.Resolve(params, fingerprint, limits)
        const result = await runtime.ReadEntities(modelId, concept, { Skip: page.Offset, Take: page.Size })
        const items = result.Entities.map((e) => ({ id: e.id, concept: e.concept, fields: WireScalar.Record(e.Snapshot()) }))
        const nextCursor = page.NextCursor(result.HasMore)
        return nextCursor === undefined ? { items } : { items, nextCursor }
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

    public async Test(modelId: string, connectorName: string): Promise<ConnectionProbeDto>
    {
        const runtime = await this.Runtime()
        const probe = await runtime.TestConnection(modelId, connectorName)
        return probe.Detail === undefined ? { ok: probe.Ok } : { ok: probe.Ok, detail: probe.Detail }
    }
}
