import { ErrorCodes, ResponseError } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { EntityDto, Page, PageParams } from '@pragmatic-tech-ai/pragmatic-protocol'
import { ConnectorMirrorMapper } from '@pragmatic-tech-ai/todl'
import type { ConnectorBinding, ConnectorSpec, ExternalFieldValue, ExternalRecord, ModelConnectorPlan, PageQuery, QueryRequest } from '@pragmatic-tech-ai/todl'
import type { PagingLimits } from '../config/paging-limits.js'
import { ConnectorInstanceView } from '../host/connector-instance-view.js'
import { EntityDtoMapper } from '../host/entity-dto-mapper.js'
import type { EntityNodeShape } from '../host/entity-dto-mapper.js'
import { KeysetPage } from '../host/paging/keyset-page.js'
import { PageFingerprint } from '../host/paging/page-request.js'
import { ConnectorBindingResolver } from './connector-binding-resolver.js'
import type { IConnectorReadAuthorization } from '../host/connector-read-authorization.js'
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
    /** Upper bound on keyset slices scanned to fill one page, so a mostly-filtered source cannot make one request unbounded. */
    private static readonly MaxSlicesPerPage = 20
    private static readonly UnknownConnectorPrefix = 'no connector for concept: '

    private readonly runtime: ConnectorRuntime

    public constructor(runtime: ConnectorRuntime)
    {
        this.runtime = runtime
    }

    /** Reads up to one page of VISIBLE rows. With an authorization each raw row is filtered by the row filter and the visible
     *  rows are field-masked; successive keyset slices are fetched until the page is full, the source is exhausted, or
     *  MaxSlicesPerPage is hit (the ONLY case that returns a short page that still carries a cursor). The cursor resumes after
     *  the last RAW key consumed, so filtered rows are never re-scanned, duplicated or skipped. A principal digest (passed only
     *  when identity is wired) is folded into the fingerprint so a cursor is bound to its principal. */
    public async ReadPage(modelId: string, concept: string, params: PageParams, limits: PagingLimits, authz?: IConnectorReadAuthorization, principalDigest?: string): Promise<Page<EntityDto>>
    {
        const plan = this.runtime.PlanOf(modelId)
        const binding = ConnectorPageReader.SingleBinding(plan, concept)
        const spec = ConnectorPageReader.SpecOf(plan, binding)
        const parts = [ConnectorPageReader.FingerprintTag, modelId, concept, binding.Connector, binding.Source, binding.IdKey]
        if (principalDigest !== undefined)
        {
            parts.push(principalDigest)
        }
        const fingerprint = PageFingerprint.Of(...parts)
        const page = KeysetPage.Resolve(params, fingerprint, limits)
        const adapter = await this.runtime.OpenAdapter(spec)
        if (adapter.CanPage !== true || adapter.QueryPage === undefined)
        {
            throw ConnectorPageReader.Unsupported(concept, ConnectorPageReader.UnsupportedNotPageable)
        }
        const request = ConnectorPageReader.RequestFor(binding)
        const items: EntityDto[] = []
        let after = page.After
        let nextAfter: ExternalFieldValue | undefined
        for (let slices = 0; slices < ConnectorPageReader.MaxSlicesPerPage; slices++)
        {
            const slice = await adapter.QueryPage(request, ConnectorPageReader.PageQueryFor(page, after))
            if (after !== undefined && slice.NextAfter === after)
            {
                // A non-advancing cursor (misbehaving adapter) would re-emit the same rows: treat the source as exhausted.
                nextAfter = undefined
                break
            }
            nextAfter = slice.NextAfter
            for (let i = 0; i < slice.Records.length; i++)
            {
                const record = slice.Records[i]!
                const node = ConnectorPageReader.VisibleNode(binding, record, authz)
                if (node !== undefined)
                {
                    items.push(EntityDtoMapper.FromNode(node, authz?.FieldMask))
                }
                if (items.length >= page.Size && i < slice.Records.length - 1)
                {
                    // Page filled mid-slice: resume after the last raw row actually consumed.
                    // A null record key is effectively unreachable (a visible row needs an id); fall back to the slice's own
                    // NextAfter rather than dropping the cursor, which would silently truncate the source.
                    nextAfter = ConnectorPageReader.KeyOf(record, binding) ?? slice.NextAfter
                    break
                }
            }
            if (items.length >= page.Size || nextAfter === undefined || nextAfter === null)
            {
                break
            }
            after = nextAfter
        }
        const nextCursor = page.NextCursor(nextAfter)
        return nextCursor === undefined ? { items } : { items, nextCursor }
    }

    private static KeyOf(record: ExternalRecord, binding: ConnectorBinding): ExternalFieldValue | undefined
    {
        const key = record[binding.IdKey]
        return key === null ? undefined : key
    }

    private static VisibleNode(binding: ConnectorBinding, record: ExternalRecord, authz: IConnectorReadAuthorization | undefined): EntityNodeShape | undefined
    {
        if (authz !== undefined && !authz.Filter.Keep(new ConnectorInstanceView(binding, record)))
        {
            return undefined
        }
        return ConnectorMirrorMapper.NodeFor(binding, record)
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

    private static SpecOf(plan: ModelConnectorPlan, binding: ConnectorBinding): ConnectorSpec
    {
        const spec = ConnectorBindingResolver.SpecOf(plan, binding)
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

    private static PageQueryFor(page: KeysetPage, after: ExternalFieldValue | undefined): PageQuery
    {
        return after === undefined ? { Limit: page.Size } : { After: after, Limit: page.Size }
    }

    private static Unsupported(concept: string, reason: string): ResponseError<undefined>
    {
        return new ResponseError(ErrorCodes.InvalidParams, `${ConnectorPageReader.UnsupportedPrefix}${concept}${reason}`)
    }
}
