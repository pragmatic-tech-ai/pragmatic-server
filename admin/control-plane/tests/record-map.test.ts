import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { FileRecordMap, MemoryRecordMap, RecordDocuments, RecordMapFormatError, RecordUnstorableError, type IRecordMap, EnvironmentRegistry, type PersistedEnvironmentRecord, EnvStatus, EnvType, Template, type EnvironmentRecord, type IdpRecord, type ClientRecord, SqlRecordMap } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { IdpRegistry } from '../idp-registry.js'
import { ClientRegistry } from '../client-registry.js'

type Thing = { name: string; tags?: string[]; nested?: { n: number } }

class RecordMapFixture
{
    public static readonly Prefix = 'recordmap-'
    public static readonly FileName = 'things.json'
    public static readonly RootKey = 'things'
    public static readonly Registry = 'conformance_things'
    public static readonly Encoding = 'utf8'
    public static readonly A: Thing = { name: 'a', tags: ['x', 'y'], nested: { n: 1 } }
    public static readonly B: Thing = { name: 'b' }
    public static readonly B2: Thing = { name: 'b2', tags: [] }
    public static readonly Dirs: string[] = []

    public static async TempFile(): Promise<string>
    {
        const dir = await mkdtemp(join(tmpdir(), RecordMapFixture.Prefix))
        RecordMapFixture.Dirs.push(dir)
        return join(dir, RecordMapFixture.FileName)
    }
}

/** Behaviour every record map shares: what Save persisted is what a fresh Load answers. */
class RecordMapConformance
{
    public static Describe(label: string, open: () => Promise<{ write: IRecordMap<Thing>; reopen: () => Promise<IRecordMap<Thing>> }>): void
    {
        const F = RecordMapFixture
        describe(`record map conformance: ${label}`, () =>
        {
            it('a fresh map is empty', async () =>
            {
                const { write } = await open()
                assert.equal((await write.Load()).size, 0)
            })

            it('saved records come back on a fresh load, with their JSON content', async () =>
            {
                const { write, reopen } = await open()
                const all = new Map([['ka', F.A], ['kb', F.B]])
                await write.Save(all, new Set(['ka', 'kb']))
                const loaded = await (await reopen()).Load()
                assert.deepEqual(Object.fromEntries(loaded), { ka: F.A, kb: F.B })
            })

            it('a changed key is replaced and a key gone from the map is removed', async () =>
            {
                const { write, reopen } = await open()
                await write.Save(new Map([['ka', F.A], ['kb', F.B]]), new Set(['ka', 'kb']))
                await write.Save(new Map([['kb', F.B2]]), new Set(['ka', 'kb']))
                assert.deepEqual(Object.fromEntries(await (await reopen()).Load()), { kb: F.B2 })
            })

            it('keys with characters a file or a table must carry verbatim survive', async () =>
            {
                const { write, reopen } = await open()
                const key = 'tenant/hive:é  x'
                await write.Save(new Map([[key, F.A]]), new Set([key]))
                assert.deepEqual([...(await (await reopen()).Load()).keys()], [key])
            })

            it('names a location for messages', async () =>
            {
                const { write } = await open()
                assert.ok(write.Location.length > 0)
            })
        })
    }
}

after(async () =>
{
    for (const dir of RecordMapFixture.Dirs)
    {
        await rm(dir, { recursive: true, force: true })
    }
})

RecordMapConformance.Describe('file', async () =>
{
    const path = await RecordMapFixture.TempFile()
    const options = { RootKey: RecordMapFixture.RootKey }
    return { write: new FileRecordMap<Thing>(path, options), reopen: async () => new FileRecordMap<Thing>(path, options) }
})

RecordMapConformance.Describe('memory', async () =>
{
    const map = new MemoryRecordMap<Thing>()
    return { write: map, reopen: async () => map }
})

SqlTestSessions.Describe('sql', (makeSession, backend) =>
{
    RecordMapConformance.Describe(backend, async () =>
    {
        const session = await makeSession()
        return { write: await SqlRecordMap.Open<Thing>(session, RecordMapFixture.Registry), reopen: () => SqlRecordMap.Open<Thing>(session, RecordMapFixture.Registry) }
    })
})

describe('FileRecordMap layout', () =>
{
    const F = RecordMapFixture

    it('writes the control plane layout { <root>: { <key>: record } } and reads it back', async () =>
    {
        const path = await F.TempFile()
        await new FileRecordMap<Thing>(path, { RootKey: F.RootKey }).Save(new Map([['ka', F.A]]), new Set(['ka']))
        assert.deepEqual(JSON.parse(await readFile(path, F.Encoding)), { things: { ka: F.A } })
    })

    it('without a root key the file is the map itself', async () =>
    {
        const path = await F.TempFile()
        await new FileRecordMap<string>(path).Save(new Map([['t1', '2026-01-01T00:00:00.000Z']]), new Set(['t1']))
        assert.deepEqual(JSON.parse(await readFile(path, F.Encoding)), { t1: '2026-01-01T00:00:00.000Z' })
    })

    it('a file that is not JSON, or whose root is not an object of records, is a RecordMapFormatError naming the file', async () =>
    {
        for (const text of ['{ not json', '[]', '{"things":[1]}', '"x"'])
        {
            const path = await F.TempFile()
            await writeFile(path, text, F.Encoding)
            await assert.rejects(new FileRecordMap<Thing>(path, { RootKey: F.RootKey }).Load(), (err: unknown) => err instanceof RecordMapFormatError && err.Location === path)
        }
    })

    it('a missing root is empty, unless the root is required', async () =>
    {
        const path = await F.TempFile()
        await writeFile(path, '{}', F.Encoding)
        assert.equal((await new FileRecordMap<Thing>(path, { RootKey: F.RootKey }).Load()).size, 0)
        await assert.rejects(new FileRecordMap<Thing>(path, { RootKey: F.RootKey, RequireRoot: true }).Load(), RecordMapFormatError)
    })

    it('WriteText replaces the write primitive', async () =>
    {
        const seen: string[] = []
        const path = await F.TempFile()
        await new FileRecordMap<Thing>(path, { RootKey: F.RootKey, WriteText: async (_p, text) => { seen.push(text) } }).Save(new Map([['ka', F.A]]), new Set(['ka']))
        assert.equal(seen.length, 1)
        assert.deepEqual(JSON.parse(seen[0] as string), { things: { ka: F.A } })
    })
})

describe('SqlRecordMap', () =>
{
    SqlTestSessions.Describe('SqlRecordMap', (makeSession, backend) =>
    {
        it(`${backend}: rows hold { id: key, record } in records_<registry>; IsEmpty follows them`, async () =>
        {
            const session = await makeSession()
            const map = await SqlRecordMap.Open<Thing>(session, RecordMapFixture.Registry)
            assert.equal(map.Location, 'records_conformance_things')
            assert.equal(await map.IsEmpty(), true)
            await map.Save(new Map([['ka', RecordMapFixture.A]]), new Set(['ka']))
            assert.equal(await map.IsEmpty(), false)
            const rows = await session.Query('SELECT id, document FROM records_conformance_things', [])
            assert.equal(rows.length, 1)
            const document = typeof rows[0]!.document === 'string' ? JSON.parse(rows[0]!.document as string) : rows[0]!.document
            assert.deepEqual(document, { id: 'ka', record: RecordMapFixture.A })
        })
    })
})

/** A record map whose next Save fails once (a database that was briefly unreachable). */
class FlakyRecordMap<T> extends MemoryRecordMap<T>
{
    public FailNext = false
    public readonly Saved: string[][] = []

    public override async Save(all: ReadonlyMap<string, T>, changed: ReadonlySet<string>): Promise<void>
    {
        if (this.FailNext)
        {
            this.FailNext = false
            throw new Error('database unreachable')
        }
        this.Saved.push([...changed].sort())
        await super.Save(all, changed)
    }
}

describe('stores over a record map', () =>
{
    it('EnvironmentRegistry and IdpRegistry carry a failed write\'s keys into the next one', async () =>
    {
        const envMap = new FlakyRecordMap<PersistedEnvironmentRecord>()
        const environments = new EnvironmentRegistry(envMap, { Running: async () => false })
        const record = (name: string): EnvironmentRecord => ({ name, template: Template.DevBlank, type: EnvType.Development, environmentId: name, hostPort: 8100, createdAt: '2026-11-20T00:00:00.000Z', status: EnvStatus.Stopped })
        envMap.FailNext = true
        await assert.rejects(environments.Put(record('a')))
        await environments.Put(record('b'))
        assert.deepEqual(envMap.Saved, [['a', 'b']])
        assert.deepEqual([...(await envMap.Load()).keys()].sort(), ['a', 'b'])
        const idpMap = new FlakyRecordMap<IdpRecord>()
        const idps = new IdpRegistry(idpMap)
        idpMap.FailNext = true
        await assert.rejects(idps.Put({ tenantId: 't1' } as IdpRecord))
        await idps.Put({ tenantId: 't2' } as IdpRecord)
        assert.deepEqual([...(await idpMap.Load()).keys()].sort(), ['t1', 't2'])
    })

    it('a record holding a NUL character is refused before anything changes (Postgres jsonb cannot store it)', async () =>
    {
        const clients = new ClientRegistry(new MemoryRecordMap<ClientRecord>())
        await assert.rejects(clients.Put({ id: 'c1', displayName: 'bad\u0000name', createdAt: '2026-11-20T00:00:00.000Z' }), RecordUnstorableError)
        assert.equal(clients.Get('c1'), undefined)
        await clients.Put({ id: 'c2', displayName: 'fine', createdAt: '2026-11-20T00:00:00.000Z' })
        assert.equal(clients.List().length, 1)
        assert.throws(() => RecordDocuments.AssertStorable({ nested: [{ 'k\u0000': 1 }] }), RecordUnstorableError)
    })
})
