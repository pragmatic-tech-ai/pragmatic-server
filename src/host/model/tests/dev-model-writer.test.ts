import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { IStorage, StorageEntry } from '@pragmatic-tech-ai/todl-runtime'
import { checkAgainst, toJSON } from '@pragmatic-tech-ai/todl'
import type { TodlDocument } from '@pragmatic-tech-ai/todl'
import { DevModelWriter, DevModelWriteFailedError, DevModelSchemaColocatedError, type IDevLanguageService, type IDevWriteDiagnostics } from '../dev-model-writer.js'
import { TodlSourceCollector } from '../todl-source-collector.js'

class MemoryStorage implements IStorage
{
    public readonly Root = 'mem'
    public readonly Files = new Map<string, string>()
    public FailOnWriteNumber = 0
    private writes = 0

    public async ReadText(path: string): Promise<string>
    {
        const text = this.Files.get(path)
        if (text === undefined) throw new Error('missing ' + path)
        return text
    }
    public async ReadBytes(path: string): Promise<Uint8Array> { return new TextEncoder().encode(await this.ReadText(path)) }
    public async WriteText(path: string, content: string): Promise<void>
    {
        this.writes += 1
        if (this.FailOnWriteNumber === this.writes) throw new Error('disk full')
        this.Files.set(path, content)
    }
    public async WriteBytes(path: string, bytes: Uint8Array): Promise<void> { this.Files.set(path, new TextDecoder().decode(bytes)) }
    public async Exists(path: string): Promise<boolean> { return this.Files.has(path) }
    public async Delete(path: string): Promise<void> { this.Files.delete(path) }
    public async CreateDirectory(): Promise<void> {}
    public async Rename(from: string, to: string): Promise<void> { this.Files.set(to, await this.ReadText(from)); this.Files.delete(from) }
    public ResetWrites(): void { this.writes = 0 }
    public async List(path: string): Promise<readonly StorageEntry[]>
    {
        const prefix = path === '' ? '' : path + '/'
        const seen = new Map<string, StorageEntry>()
        for (const key of this.Files.keys())
        {
            if (!key.startsWith(prefix)) continue
            const rest = key.slice(prefix.length)
            const slash = rest.indexOf('/')
            const name = slash < 0 ? rest : rest.slice(0, slash)
            seen.set(name, { Name: name, IsDirectory: slash >= 0 })
        }
        return [...seen.values()]
    }
}

class FakeLanguageService implements IDevLanguageService
{
    public GraphRevision = 1
    public readonly Changes: string[] = []
    public async ResolveBasesFor(): Promise<{ bases: TodlDocument[] }> { return { bases: [toJSON(checkAgainst([], [{ uri: 'schema.todl', text: Fixture.Schema }]).model)] } }
    public DidChange(uri: string): void { this.Changes.push(uri); this.GraphRevision += 1 }
    public async WhenIdle(): Promise<void> {}
}

class Fixture
{
    public static readonly Schema = 'namespace shop {\n  concept Customer { name : string?; }\n}\n'
    public static readonly Model = 'namespace shop {\n  model M : shop {\n    Customer c1 { name = "Ada"; }\n  }\n}\n'
    public static readonly Other = 'namespace shop {' + String.fromCharCode(10) + '  model N : shop {' + String.fromCharCode(10) + '    Customer c2 { name = "Bo"; }' + String.fromCharCode(10) + '  }' + String.fromCharCode(10) + '}' + String.fromCharCode(10)
    public static readonly Padding = '\n\n\n'
    public readonly Storage = new MemoryStorage()
    public readonly Lang = new FakeLanguageService()
    public readonly Writer = new DevModelWriter(this.Lang)
    public readonly Member = { Storage: this.Storage }
    public static readonly Identity = { model: 'sol', version: '0.0.0', namespace: 'shop' }

    constructor()
    {
        this.Storage.Files.set('model.todl', Fixture.Model)
        this.Storage.Files.set('dist/skip.todl', 'garbage')
        this.Storage.Files.set('readme.md', 'x')
    }
}

describe('DevModelWriter', () =>
{
    test('Prepare collects sources and the writer commits a create', async () =>
    {
        const f = new Fixture()
        const { writer, sources } = await f.Writer.Prepare(f.Member, Fixture.Identity)
        assert.deepEqual(sources.map(s => s.uri).sort(), ['model.todl'])
        writer.Begin()
        writer.CreateNode('shop.Customer', new Map())
        const graph = writer.Commit()
        assert.equal(graph.NodesByLabel('Customer').length, 2)
    })

    test('the baked graph carries the explicit model and version, not the namespace default', async () =>
    {
        const f = new Fixture()
        const { writer } = await f.Writer.Prepare(f.Member, Fixture.Identity)
        writer.Begin()
        writer.CreateNode('shop.Customer', new Map())
        const type = writer.Commit().NodesByLabel('Customer')[0]!.type as unknown as { manifest: { model: string; version: string } }
        assert.equal(type.manifest.model, Fixture.Identity.model)
        assert.equal(type.manifest.version, Fixture.Identity.version)
        assert.notEqual(type.manifest.model, Fixture.Identity.namespace)
    })

    test('collector skips build and vendor directories at any depth', async () =>
    {
        const f = new Fixture()
        for (const dir of ['node_modules/pkg', '.git/x', 'out', 'build', 'sub/node_modules/pkg', 'sub/dist', 'sub/deep/.git']) f.Storage.Files.set(dir + '/hidden.todl', 'garbage')
        f.Storage.Files.set('schema.todl', Fixture.Schema)
        f.Storage.Files.set('sub/kept.todl', Fixture.Schema)
        const uris = (await new TodlSourceCollector().Collect(f.Storage)).map(s => s.uri).sort()
        assert.deepEqual(uris, ['model.todl', 'schema.todl', 'sub/kept.todl'])
    })

    test('restore deletes a file that did not exist before the failed write', async () =>
    {
        const f = new Fixture()
        const { draft, writer } = await f.Writer.Prepare(f.Member, Fixture.Identity)
        writer.Begin()
        writer.CreateNode('shop.Customer', new Map())
        writer.Commit()
        const targets = [...draft.toTodlByFile().keys()]
        const created = targets[0] as string
        f.Storage.Files.delete(created)
        const survivors = new Map(targets.slice(1).map(uri => [uri, f.Storage.Files.get(uri)]))
        f.Storage.ResetWrites()
        f.Storage.FailOnWriteNumber = 2
        await assert.rejects(() => f.Writer.Persist(draft, f.Member), DevModelWriteFailedError)
        assert.equal(f.Storage.Files.has(created), false)
        for (const [uri, text] of survivors) assert.equal(f.Storage.Files.get(uri), text)
    })

    test('Persist writes changed files and returns a bumped revision', async () =>
    {
        const f = new Fixture()
        const { draft, writer } = await f.Writer.Prepare(f.Member, Fixture.Identity)
        writer.Begin()
        writer.CreateNode('shop.Customer', new Map())
        writer.Commit()
        const before = f.Lang.GraphRevision
        const revision = await f.Writer.Persist(draft, f.Member)
        assert.ok(revision > before)
        assert.ok(f.Lang.Changes.length > 0)
        for (const [uri, text] of draft.toTodlByFile()) assert.equal(f.Storage.Files.get(uri), text)
    })

    test('a failing second WriteText restores every file and surfaces Failed', async () =>
    {
        const f = new Fixture()
        f.Storage.Files.set('other.todl', Fixture.Other + Fixture.Padding)
        f.Storage.Files.set('model.todl', Fixture.Model + Fixture.Padding)
        const { draft } = await f.Writer.Prepare(f.Member, Fixture.Identity)
        const targets = [...draft.toTodlByFile().keys()]
        assert.ok(targets.length >= 2, 'fixture must yield two target files')
        const prior = new Map(targets.map(uri => [uri, f.Storage.Files.get(uri)]))
        const first = targets[0] as string
        assert.notEqual(draft.toTodlByFile().get(first), prior.get(first), 'first write must actually change the file')
        f.Storage.ResetWrites()
        f.Storage.FailOnWriteNumber = 2
        await assert.rejects(() => f.Writer.Persist(draft, f.Member), DevModelWriteFailedError)
        f.Storage.FailOnWriteNumber = 0
        for (const [uri, text] of prior) assert.equal(f.Storage.Files.get(uri), text)
        assert.equal(f.Lang.Changes.length, 0)
    })

    test('SourceHash is stable and changes with a source', async () =>
    {
        const f = new Fixture()
        const collector = new TodlSourceCollector()
        const a = f.Writer.SourceHash(await collector.Collect(f.Storage))
        const b = f.Writer.SourceHash(await collector.Collect(f.Storage))
        assert.equal(a, b)
        f.Storage.Files.set('model.todl', Fixture.Model + '\n')
        assert.notEqual(f.Writer.SourceHash(await collector.Collect(f.Storage)), a)
    })

    test('Prepare refuses a member whose own sources hold schema beside instances', async () =>
    {
        const f = new Fixture()
        f.Storage.Files.set('extra.todl', 'namespace shop { concept Order { total : string?; } }')
        await assert.rejects(() => f.Writer.Prepare(f.Member, Fixture.Identity), DevModelSchemaColocatedError)
    })

    test('a refresh failure after a successful write still persists and returns the last-known revision', async () =>
    {
        const f = new Fixture()
        const seen: unknown[] = []
        const diagnostics: IDevWriteDiagnostics = { RefreshFailed: e => { seen.push(e) }, WriteFailed: () => {} }
        f.Lang.DidChange = (): void => { throw new Error('refresh exploded at /secret/path') }
        const writer = new DevModelWriter(f.Lang, undefined, diagnostics)
        const { draft, writer: cypher } = await writer.Prepare(f.Member, Fixture.Identity)
        cypher.Begin()
        cypher.CreateNode('shop.Customer', new Map())
        cypher.Commit()
        const before = f.Lang.GraphRevision
        const revision = await writer.Persist(draft, f.Member)
        assert.equal(revision, before)
        assert.equal(seen.length, 1)
        for (const [uri, text] of draft.toTodlByFile()) assert.equal(f.Storage.Files.get(uri), text)
    })

    test('DevModelWriteFailedError carries no raw error text or file paths', async () =>
    {
        const f = new Fixture()
        const { draft, writer } = await f.Writer.Prepare(f.Member, Fixture.Identity)
        writer.Begin()
        writer.CreateNode('shop.Customer', new Map())
        writer.Commit()
        f.Storage.ResetWrites()
        f.Storage.FailOnWriteNumber = 1
        await assert.rejects(() => f.Writer.Persist(draft, f.Member), (e: unknown) => e instanceof DevModelWriteFailedError && !e.message.includes('disk full') && !e.message.includes('.todl'))
    })
})
