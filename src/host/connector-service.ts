import type { ConnectorRuntime } from '../connectors/connector-runtime.js'
import type { ConnectorModelDto, ConnectorWriteBackParams, EntityDto, FlushOutcomeDto, Page, ConnectionProbeDto } from '@pragmatic-tech-ai/pragmatic-protocol'

/** Per-connection façade over the 6A ConnectorRuntime: lazily holds one runtime (rebuilt on Invalidate, i.e.
 *  connector/refresh or solution/open) and maps engine info shapes to camelCase wire DTOs. Carries names,
 *  node ids, and scalar field values only — never a connection Config or secret. */
export class ConnectorService
{
    private readonly runtimeFactory: () => Promise<ConnectorRuntime>
    private runtimePromise: Promise<ConnectorRuntime> | undefined

    public constructor(runtimeFactory: () => Promise<ConnectorRuntime>)
    {
        this.runtimeFactory = runtimeFactory
    }

    public Invalidate(): void
    {
        this.runtimePromise = undefined
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

    public async Read(modelId: string, concept: string): Promise<Page<EntityDto>>
    {
        const runtime = await this.Runtime()
        const entities = await runtime.ReadEntities(modelId, concept)
        return { items: entities.map((e) => ({ id: e.id, concept: e.concept, fields: ConnectorService.Fields(e.Snapshot()) })) }
    }

    public async WriteBack(params: ConnectorWriteBackParams): Promise<FlushOutcomeDto>
    {
        const runtime = await this.Runtime()
        const outcome = await runtime.WriteBack(params.modelId, params.dirty, params.deleted)
        return {
            results: outcome.Results.map((r) => ({ applied: r.Applied, conflicts: r.Conflicts.map((c) => ({ key: ConnectorService.Scalar(c.Key), reason: c.Reason })) })),
            diagnostics: outcome.Diagnostics.map((d) => ({ code: d.code, message: d.message })),
        }
    }

    public async Test(modelId: string, connectorName: string): Promise<ConnectionProbeDto>
    {
        const runtime = await this.Runtime()
        const probe = await runtime.TestConnection(modelId, connectorName)
        return probe.Detail === undefined ? { ok: probe.Ok } : { ok: probe.Ok, detail: probe.Detail }
    }

    private static Fields(snapshot: Record<string, unknown>): Record<string, string | number | boolean | null>
    {
        const out: Record<string, string | number | boolean | null> = {}
        for (const key of Object.keys(snapshot))
        {
            out[key] = ConnectorService.Scalar(snapshot[key])
        }
        return out
    }

    private static Scalar(value: unknown): string | number | boolean | null
    {
        if (value === null || value === undefined) { return null }
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') { return value }
        return String(value)
    }
}
