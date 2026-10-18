import { ErrorCodes, ResponseError } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { EntityDto, Page, PageParams } from '@pragmatic-tech-ai/pragmatic-protocol'
import { ConnectorMirrorMapper } from '@pragmatic-tech-ai/todl'
import type { ConnectorBinding, ConnectorSpec, ModelConnectorPlan, PageQuery, QueryRequest } from '@pragmatic-tech-ai/todl'
import type { PagingLimits } from '../config/paging-limits.js'
import { EntityDtoMapper } from '../host/entity-dto-mapper.js'
import { KeysetPage } from '../host/paging/keyset-page.js'
import { PageFingerprint } from '../host/paging/page-request.js'
import type { ConnectorRuntime } from './connector-runtime.js'

/** Serves one keyset page of ONE connector binding straight from its adapter. It reads the model plan only: it never
 *  prepares/materializes the model and opens only the target binding's connector (the ConnectorPrefetch precedent of
 *  staying out of the materializing runtime). Carries names, node ids and scalar values only: never a Config or secret. */
export class ConnectorPageReader
{
    private static readonly FingerprintTag = 'connectorPage'
    private static readonly UnsupportedPrefix = 'connector/readPage unsupported for concept: '
    private static readonly UnsupportedNotSingleBinding = ' (requires exactly one binding)'
    private static readonly UnsupportedNotPageable = ' (its adapter cannot serve keyset pages)'
    private static readonly UnknownConnectorPrefix = 'no connector for concept: '

    private readonly runtime: ConnectorRuntime

    public constructor(runtime: ConnectorRuntime)
    {
        this.runtime = runtime
    }

    public async ReadPage(modelId: string, concept: string, params: PageParams, limits: PagingLimits): Promise<Page<EntityDto>>
    {
        const plan = this.runtime.PlanOf(modelId)
        const binding = ConnectorPageReader.SingleBinding(plan, concept)
        const spec = ConnectorPageReader.SpecOf(plan, binding)
        const fingerprint = PageFingerprint.Of(ConnectorPageReader.FingerprintTag, modelId, concept, binding.Connector, binding.Source, binding.IdKey)
        const page = KeysetPage.Resolve(params, fingerprint, limits)
        const adapter = await this.runtime.OpenAdapter(spec)
        if (adapter.CanPage !== true || adapter.QueryPage === undefined)
        {
            throw ConnectorPageReader.Unsupported(concept, ConnectorPageReader.UnsupportedNotPageable)
        }
        const slice = await adapter.QueryPage(ConnectorPageReader.RequestFor(binding), ConnectorPageReader.PageQueryFor(page))
        const items: EntityDto[] = []
        for (const record of slice.Records)
        {
            const node = ConnectorMirrorMapper.NodeFor(binding, record)
            if (node !== undefined)
            {
                items.push(EntityDtoMapper.FromNode(node))
            }
        }
        const nextCursor = page.NextCursor(slice.NextAfter)
        return nextCursor === undefined ? { items } : { items, nextCursor }
    }

    private static SingleBinding(plan: ModelConnectorPlan, concept: string): ConnectorBinding
    {
        const bindings = plan.Bindings.filter(b => b.Concept === concept)
        if (bindings.length !== 1)
        {
            throw ConnectorPageReader.Unsupported(concept, ConnectorPageReader.UnsupportedNotSingleBinding)
        }
        return bindings[0]!
    }

    /** Links by the qualified ConnectorId when present, else the bare Connector name (same rule as the engine's ConnectorLookup). */
    private static SpecOf(plan: ModelConnectorPlan, binding: ConnectorBinding): ConnectorSpec
    {
        const key = binding.ConnectorId ?? binding.Connector
        const spec = plan.Connectors.find(c => (c.Id ?? c.Name) === key)
        if (spec === undefined)
        {
            throw new ResponseError(ErrorCodes.InvalidRequest, `${ConnectorPageReader.UnknownConnectorPrefix}${binding.Concept}`)
        }
        return spec
    }

    private static RequestFor(binding: ConnectorBinding): QueryRequest
    {
        const fields = [binding.IdKey, ...Object.values(binding.FieldMap).filter(external => external !== binding.IdKey)]
        return { Source: binding.Source, Fields: [...new Set(fields)], OrderKey: binding.IdKey }
    }

    private static PageQueryFor(page: KeysetPage): PageQuery
    {
        return page.After === undefined ? { Limit: page.Size } : { After: page.After, Limit: page.Size }
    }

    private static Unsupported(concept: string, reason: string): ResponseError<undefined>
    {
        return new ResponseError(ErrorCodes.InvalidParams, `${ConnectorPageReader.UnsupportedPrefix}${concept}${reason}`)
    }
}
