import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ServiceProvider } from '@pragmatic-tech-ai/todl-runtime'
import { DataSourceAdapterCatalog, DataSourceKind, WriteConcurrency, WriteAtomicity } from '@pragmatic-tech-ai/todl'
import type { ConnectorSpec, ConnectorBinding, IDataSourceAdapter, IDataSourceAdapterFactory, ResolvedConnection, QueryRequest, WriteBatch, WriteResult, ExternalRecord, PageQuery, PageSlice } from '@pragmatic-tech-ai/todl'
import { CursorStaleError, PageCursorCodec } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { EntityDto, Page } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { IInstanceFilter, IInstanceView } from '@pragmatic-tech-ai/todl'
import { AllowAllFieldReadMask } from '../../host/cypher/field-masked-graph-query.js'
import type { IFieldReadMask } from '../../host/cypher/field-masked-graph-query.js'
import { ConnectorReadAuthorizations } from '../../host/connector-read-authorization.js'
import type { IConnectorReadAuthorization } from '../../host/connector-read-authorization.js'
import { ConnectorRuntime } from '../connector-runtime.js'
import { ConnectorPageReader } from '../connector-page-reader.js'
import { PagingLimits } from '../../config/paging-limits.js'

class KeysetAdapter implements IDataSourceAdapter
{
    public Queries = 0
    public readonly CanPage: boolean
    private readonly rows: readonly ExternalRecord[]

    public constructor(rows: readonly ExternalRecord[], canPage: boolean)
    {
        this.rows = rows
        this.CanPage = canPage
    }

    public Query(_request: QueryRequest): Promise<readonly ExternalRecord[]>
    {
        this.Queries++
        return Promise.resolve(this.rows)
    }

    public QueryPage(request: QueryRequest, page: PageQuery): Promise<PageSlice>
    {
        assert.equal(request.OrderKey, 'id')
        const sorted = [...this.rows].sort((a, b) => String(a['id']) < String(b['id']) ? -1 : 1)
        const after = page.After
        const rest = after === undefined ? sorted : sorted.filter(r => String(r['id']) > String(after))
        const records = rest.slice(0, page.Limit)
        const full = records.length === page.Limit
        return Promise.resolve(full ? { Records: records, NextAfter: records[records.length - 1]!['id']! } : { Records: records })
    }

    public Apply(_batch: WriteBatch): Promise<WriteResult>
    {
        return Promise.resolve({ Applied: 0, Failures: [] })
    }

    public Dispose(): Promise<void>
    {
        return Promise.resolve()
    }
}

class RecordingFactory implements IDataSourceAdapterFactory
{
    public readonly Kind = DataSourceKind.Sql
    public readonly Opened: string[] = []
    public readonly Adapters = new Map<string, KeysetAdapter>()
    private readonly canPage: boolean
    private readonly rows: readonly ExternalRecord[]

    public constructor(canPage: boolean, rows: readonly ExternalRecord[])
    {
        this.canPage = canPage
        this.rows = rows
    }

    public Open(connection: ResolvedConnection): Promise<IDataSourceAdapter>
    {
        const name = connection.Config['name']!
        this.Opened.push(name)
        const adapter = new KeysetAdapter(this.rows, this.canPage)
        this.Adapters.set(name, adapter)
        return Promise.resolve(adapter)
    }
}

/** Records which specs are opened (bypassing the catalog's memoization) by handing back the factory's adapter directly. */
class RawCatalog extends DataSourceAdapterCatalog
{
    private readonly raw: RecordingFactory

    public constructor(raw: RecordingFactory)
    {
        super()
        this.raw = raw
    }

    public override Open(spec: ConnectorSpec, _services: unknown): Promise<IDataSourceAdapter>
    {
        return this.raw.Open({ Kind: spec.Kind, Config: spec.Config as Record<string, string> })
    }
}

class Fixtures
{
    public static readonly Limits = new PagingLimits(100, 1000)
    public static readonly ModelId = 'shop'

    public static Rows(count: number): ExternalRecord[]
    {
        const out: ExternalRecord[] = []
        for (let i = 0; i < count; i++)
        {
            out.push({ id: `C${i}`, name: `n${i}` })
        }
        return out
    }

    public static Spec(name: string): ConnectorSpec
    {
        return { Name: name, Kind: DataSourceKind.Sql, Config: { name } } as unknown as ConnectorSpec
    }

    public static Binding(concept: string, connector: string, source: string): ConnectorBinding
    {
        return { Concept: concept, Connector: connector, Source: source, IdKey: 'id', FieldMap: { name: 'name' }, Writable: false, Concurrency: WriteConcurrency.LastWriteWins, Atomicity: WriteAtomicity.Sequential }
    }

    public static Runtime(factory: RecordingFactory, bindings: ConnectorBinding[], connectors: ConnectorSpec[]): ConnectorRuntime
    {
        const catalog = new RawCatalog(factory)
        const services = new ServiceProvider()
        services.registerInstance(DataSourceAdapterCatalog.ServiceKey, catalog)
        const plan = { Model: Fixtures.ModelId, Version: '1', Connectors: connectors, Bindings: bindings }
        return new ConnectorRuntime([{ ModelId: Fixtures.ModelId, Plan: plan, Base: {} as never }], services)
    }

    public static Two(factory: RecordingFactory): ConnectorRuntime
    {
        return Fixtures.Runtime(factory,
            [Fixtures.Binding('shop.A', 'a', 'A'), Fixtures.Binding('shop.B', 'b', 'B')],
            [Fixtures.Spec('a'), Fixtures.Spec('b')])
    }

    public static IsStale(error: { code?: number }): boolean
    {
        return error.code === CursorStaleError.Code
    }
}

test('readPage tiles the whole set by keyset cursor with no dup or skip', async () =>
{
    const reader = new ConnectorPageReader(Fixtures.Two(new RecordingFactory(true, Fixtures.Rows(5))))
    const pages: string[][] = []
    let cursor: string | undefined
    do
    {
        const page = await reader.ReadPage(Fixtures.ModelId, 'shop.A', { cursor, pageSize: 2 }, Fixtures.Limits)
        pages.push(page.items.map(i => i.id))
        assert.ok(page.items.every(i => i.concept === 'shop.A'))
        cursor = page.nextCursor
    }
    while (cursor !== undefined)
    assert.deepEqual(pages.map(p => p.length), [2, 2, 1])
    const flat = pages.flat()
    assert.equal(new Set(flat).size, 5)
    assert.deepEqual(flat, [...flat].sort())
    assert.equal(flat[0], 'shop.A#a.A#C0')
})

test('readPage on a non-pageable adapter or multi-binding concept is Unsupported', async () =>
{
    const notPageable = Fixtures.Two(new RecordingFactory(false, Fixtures.Rows(3)))
    await assert.rejects(() => new ConnectorPageReader(notPageable).ReadPage(Fixtures.ModelId, 'shop.A', {}, Fixtures.Limits), /unsupported/)
    const dual = Fixtures.Runtime(new RecordingFactory(true, Fixtures.Rows(3)),
        [Fixtures.Binding('shop.A', 'a', 'A'), Fixtures.Binding('shop.A', 'a', 'A2')], [Fixtures.Spec('a')])
    await assert.rejects(() => new ConnectorPageReader(dual).ReadPage(Fixtures.ModelId, 'shop.A', {}, Fixtures.Limits), /exactly one binding/)
    await assert.rejects(() => new ConnectorPageReader(dual).ReadPage(Fixtures.ModelId, 'shop.Missing', {}, Fixtures.Limits), /unsupported/)
})

test('readPage does not materialize the model nor open another concept adapter', async () =>
{
    const factory = new RecordingFactory(true, Fixtures.Rows(3))
    const runtime = Fixtures.Two(factory)
    let prepared = 0
    runtime.PrepareModel = (): Promise<void> =>
    {
        prepared++
        return Promise.resolve()
    }
    const page = await new ConnectorPageReader(runtime).ReadPage(Fixtures.ModelId, 'shop.A', { pageSize: 2 }, Fixtures.Limits)
    assert.equal(page.items.length, 2)
    assert.equal(prepared, 0)
    assert.deepEqual([...new Set(factory.Opened)], ['a'])
    assert.equal(factory.Adapters.get('a')!.Queries, 0)
})

test('a forged cursor whose key payload is not a string or number is stale', async () =>
{
    const reader = new ConnectorPageReader(Fixtures.Two(new RecordingFactory(true, Fixtures.Rows(5))))
    const first = await reader.ReadPage(Fixtures.ModelId, 'shop.A', { pageSize: 2 }, Fixtures.Limits)
    const decoded = PageCursorCodec.Decode(first.nextCursor!)!
    const prefix = decoded.fingerprint.slice(0, decoded.fingerprint.indexOf('\u0000') + 1)
    for (const payload of ['{"a":1}', '[1]', 'true', 'null', '1e999'])
    {
        const forged = PageCursorCodec.Encode({ offset: 0, fingerprint: `${prefix}${payload}` })
        await assert.rejects(() => reader.ReadPage(Fixtures.ModelId, 'shop.A', { cursor: forged, pageSize: 2 }, Fixtures.Limits), Fixtures.IsStale)
    }
})

test('a readPage cursor minted for a different concept is stale', async () =>
{
    const reader = new ConnectorPageReader(Fixtures.Two(new RecordingFactory(true, Fixtures.Rows(5))))
    const first = await reader.ReadPage(Fixtures.ModelId, 'shop.A', { pageSize: 2 }, Fixtures.Limits)
    assert.ok(first.nextCursor !== undefined)
    await assert.rejects(() => reader.ReadPage(Fixtures.ModelId, 'shop.B', { cursor: first.nextCursor, pageSize: 2 }, Fixtures.Limits), Fixtures.IsStale)
    await assert.rejects(() => reader.ReadPage(Fixtures.ModelId, 'shop.A', { cursor: 'garbage', pageSize: 2 }, Fixtures.Limits), Fixtures.IsStale)
})

test('keyset cursor round-trips keys containing the separator and JSON metacharacters', async () =>
{
    const keys = ['a\u0000b', 'q"uote', 'back\\slash', 'has#hash', '{"x":1}']
    const rows = keys.map(k => ({ id: k, name: 'n' }))
    const reader = new ConnectorPageReader(Fixtures.Two(new RecordingFactory(true, rows)))
    const seen: string[] = []
    let cursor: string | undefined
    do
    {
        const page = await reader.ReadPage(Fixtures.ModelId, 'shop.A', { cursor, pageSize: 1 }, Fixtures.Limits)
        seen.push(...page.items.map(i => i.id.slice('shop.A#a.A#'.length)))
        cursor = page.nextCursor
    }
    while (cursor !== undefined)
    assert.deepEqual([...seen].sort(), [...keys].sort())
})

class RowFilter implements IInstanceFilter
{
    private readonly keep: (n: number) => boolean

    public constructor(keep: (n: number) => boolean)
    {
        this.keep = keep
    }

    public Keep(view: IInstanceView): boolean
    {
        return this.keep(Number(String(view.Field('name')).replace(/\D/g, '')))
    }
}

class DenyNameMask implements IFieldReadMask
{
    public CanRead(concept: string, field: string): boolean
    {
        return !(concept === 'shop.A' && field === 'name')
    }
}

class AuthFx
{
    public static IdOf(item: EntityDto): string
    {
        return item.id.slice('shop.A#a.A#'.length)
    }

    public static Authz(keep: (n: number) => boolean, mask: IFieldReadMask = AllowAllFieldReadMask.Instance): IConnectorReadAuthorization
    {
        return { Filter: new RowFilter(keep), FieldMask: mask }
    }

    public static async Drain(reader: ConnectorPageReader, authz: IConnectorReadAuthorization | undefined, digest: string | undefined, size: number): Promise<Page<EntityDto>[]>
    {
        const pages: Page<EntityDto>[] = []
        let cursor: string | undefined
        do
        {
            const page = await reader.ReadPage(Fixtures.ModelId, 'shop.A', { cursor, pageSize: size }, Fixtures.Limits, authz, digest)
            pages.push(page)
            cursor = page.nextCursor
        }
        while (cursor !== undefined)
        return pages
    }
}

test('paged read tiles the VISIBLE subset with no dup/skip', async () =>
{
    const reader = new ConnectorPageReader(Fixtures.Two(new RecordingFactory(true, Fixtures.Rows(6))))
    const pages = await AuthFx.Drain(reader, AuthFx.Authz(n => [1, 3, 4].includes(n)), 'p', 2)
    assert.deepEqual(pages.map(p => p.items.map(AuthFx.IdOf)), [['C1', 'C3'], ['C4']])
    assert.equal(pages[1]!.nextCursor, undefined)
})

test('a filtered page is filled, not silently short', async () =>
{
    const reader = new ConnectorPageReader(Fixtures.Two(new RecordingFactory(true, Fixtures.Rows(6))))
    const page = await reader.ReadPage(Fixtures.ModelId, 'shop.A', { pageSize: 2 }, Fixtures.Limits, AuthFx.Authz(n => n === 1 || n === 3), 'p')
    assert.deepEqual(page.items.map(AuthFx.IdOf), ['C1', 'C3'])
    assert.ok(page.nextCursor !== undefined)
})

test('NextAfter resumes by the last RAW key consumed', async () =>
{
    const reader = new ConnectorPageReader(Fixtures.Two(new RecordingFactory(true, Fixtures.Rows(8))))
    const authz = AuthFx.Authz(n => n % 2 === 0)
    const first = await reader.ReadPage(Fixtures.ModelId, 'shop.A', { pageSize: 3 }, Fixtures.Limits, authz, 'p')
    assert.deepEqual(first.items.map(AuthFx.IdOf), ['C0', 'C2', 'C4'])
    assert.ok(PageCursorCodec.Decode(first.nextCursor!)!.fingerprint.endsWith('"C4"'))
    const second = await reader.ReadPage(Fixtures.ModelId, 'shop.A', { cursor: first.nextCursor, pageSize: 3 }, Fixtures.Limits, authz, 'p')
    assert.deepEqual(second.items.map(AuthFx.IdOf), ['C6'])
    assert.equal(second.nextCursor, undefined)
})

test('scan bound yields a short page WITH a cursor', async () =>
{
    const reader = new ConnectorPageReader(Fixtures.Two(new RecordingFactory(true, Fixtures.Rows(100))))
    const authz = AuthFx.Authz(n => n === 99)
    const page = await reader.ReadPage(Fixtures.ModelId, 'shop.A', { pageSize: 2 }, Fixtures.Limits, authz, 'p')
    assert.ok(page.items.length < 2)
    assert.ok(page.nextCursor !== undefined)
    const all = await AuthFx.Drain(reader, authz, 'p', 2)
    assert.deepEqual(all.flatMap(p => p.items.map(AuthFx.IdOf)), ['C99'])
})

test('a cursor minted for principal A is stale for principal B', async () =>
{
    const reader = new ConnectorPageReader(Fixtures.Two(new RecordingFactory(true, Fixtures.Rows(6))))
    const authz = AuthFx.Authz(() => true)
    const first = await reader.ReadPage(Fixtures.ModelId, 'shop.A', { pageSize: 2 }, Fixtures.Limits, authz, 'A')
    await assert.rejects(() => reader.ReadPage(Fixtures.ModelId, 'shop.A', { cursor: first.nextCursor, pageSize: 2 }, Fixtures.Limits, authz, 'B'), Fixtures.IsStale)
    const ok = await reader.ReadPage(Fixtures.ModelId, 'shop.A', { cursor: first.nextCursor, pageSize: 2 }, Fixtures.Limits, authz, 'A')
    assert.equal(ok.items.length, 2)
})

test('no-identity paged read is unchanged', async () =>
{
    const reader = new ConnectorPageReader(Fixtures.Two(new RecordingFactory(true, Fixtures.Rows(5))))
    const bare = await AuthFx.Drain(reader, undefined, undefined, 2)
    const allow = await AuthFx.Drain(reader, ConnectorReadAuthorizations.AllowAll(), undefined, 2)
    assert.deepEqual(allow, bare)
    assert.deepEqual(bare.map(p => p.items.length), [2, 2, 1])
})

test('filtering opens no other concept adapter and no PrepareModel', async () =>
{
    const factory = new RecordingFactory(true, Fixtures.Rows(6))
    const runtime = Fixtures.Two(factory)
    let prepared = 0
    runtime.PrepareModel = (): Promise<void> =>
    {
        prepared++
        return Promise.resolve()
    }
    await AuthFx.Drain(new ConnectorPageReader(runtime), AuthFx.Authz(n => n % 3 === 0), 'p', 1)
    assert.equal(prepared, 0)
    assert.deepEqual([...new Set(factory.Opened)], ['a'])
})

test('the field mask hides masked fields on paged rows using the qualified concept name', async () =>
{
    const reader = new ConnectorPageReader(Fixtures.Two(new RecordingFactory(true, Fixtures.Rows(3))))
    const page = await reader.ReadPage(Fixtures.ModelId, 'shop.A', { pageSize: 5 }, Fixtures.Limits, AuthFx.Authz(() => true, new DenyNameMask()), 'p')
    assert.equal(page.items.length, 3)
    assert.ok(page.items.every(i => !('name' in i.fields)))
})
