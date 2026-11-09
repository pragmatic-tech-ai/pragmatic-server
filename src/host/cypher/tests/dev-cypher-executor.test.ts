import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkAgainst, toJSON } from '@pragmatic-tech-ai/todl'
import type { TodlDocument, ModelDraft } from '@pragmatic-tech-ai/todl'
import type { IStorage, StorageEntry } from '@pragmatic-tech-ai/todl-runtime'
import { AppWriteStatus } from '@pragmatic-tech-ai/pragmatic-protocol'
import { DevModelWriter, DevModelWriteFailedError } from '../../model/dev-model-writer.js'
import type { IDevLanguageService } from '../../model/dev-model-writer.js'
import { DevCypherExecutor } from '../dev-cypher-executor.js'
import { OpenDevWriteSecurity } from '../dev-write-security.js'
import { InProcessWriteLock, WriteLockBusyError, type IWriteLease, type IWriteLock } from '../write-lock.js'

class MemoryStorage implements IStorage
{
    public readonly Root = 'mem'
    public readonly Files = new Map<string, string>()

    public async ReadText(path: string): Promise<string> { return this.Files.get(path)! }
    public async ReadBytes(path: string): Promise<Uint8Array> { return new TextEncoder().encode(await this.ReadText(path)) }
    public async WriteText(path: string, content: string): Promise<void> { this.Files.set(path, content) }
    public async WriteBytes(): Promise<void> {}
    public async Exists(path: string): Promise<boolean> { return this.Files.has(path) }
    public async Delete(path: string): Promise<void> { this.Files.delete(path) }
    public async CreateDirectory(): Promise<void> {}
    public async Rename(): Promise<void> {}
    public async List(): Promise<readonly StorageEntry[]>
    {
        return [...this.Files.keys()].map(Name => ({ Name, IsDirectory: false }))
    }
}

class StubLanguageService implements IDevLanguageService
{
    public GraphRevision = 7

    public async ResolveBasesFor(): Promise<{ bases: TodlDocument[] }>
    {
        return { bases: [toJSON(checkAgainst([], [{ uri: 'schema.todl', text: ExecutorFixture.Schema }]).model)] }
    }

    public DidChange(): void {}
    public DidDelete(): void {}
    public async WhenIdle(): Promise<void> {}
}

/** A writer whose Persist always fails the way DevModelWriter does after its compensating restore. */
class FailingPersistWriter extends DevModelWriter
{
    public override async Persist(_draft: ModelDraft, _member: { Storage: IStorage }): Promise<number>
    {
        throw new DevModelWriteFailedError('disk full')
    }
}

class ExecutorFixture
{
    public static readonly Schema = 'namespace shop {\n  concept Customer { name : string?; }\n}\n'
    public static readonly Model = 'namespace shop {\n  model shopModel : shop {\n    Customer c1 { name = "Ada"; }\n  }\n}\n'
    public static readonly Create = "CREATE (:Customer {name: 'Bo'})"
}

test('a Persist failure surfaces as in-band Failed with the fixed reason and no partial result', async () =>
{
    const storage = new MemoryStorage()
    storage.Files.set('model.todl', ExecutorFixture.Model)
    const language = new StubLanguageService()
    const executor = new DevCypherExecutor(new FailingPersistWriter(language), () => language.GraphRevision)
    const result = await executor.Execute(
        { cypher: ExecutorFixture.Create, parameters: new Map(), timeoutMs: 5000, maxVarLength: 8 },
        { member: { Storage: storage }, identity: { model: 'sol', version: '0.0.0', namespace: 'shop' } },
        new OpenDevWriteSecurity())
    assert.equal(result.status, AppWriteStatus.Failed)
    assert.equal(result.reason, 'the model could not be persisted; no changes were kept')
    assert.ok(!JSON.stringify(result).includes('disk full'))
    assert.deepEqual(result.counts, { nodesCreated: 0, nodesDeleted: 0, relationshipsCreated: 0, relationshipsDeleted: 0, propertiesSet: 0 })
    assert.equal(result.revision, 7)
    assert.deepEqual(result.rows, [])
    assert.equal(storage.Files.get('model.todl'), ExecutorFixture.Model)
})

/** A lock whose lease is granted (or refused) and reports itself held (or lost) as the test dictates. */
class ScriptedLock implements IWriteLock
{
    public Acquired = 0
    public Released = 0

    constructor(private readonly busy: boolean, private readonly held: boolean)
    {
    }

    public async Acquire(): Promise<IWriteLease>
    {
        if (this.busy) throw new WriteLockBusyError()
        this.Acquired++
        return { Held: async () => this.held, Release: async () => { this.Released++ } }
    }
}

class LockFixture
{
    public static async Run(lock: IWriteLock, storage: MemoryStorage): Promise<Awaited<ReturnType<DevCypherExecutor['Execute']>>>
    {
        const language = new StubLanguageService()
        const executor = new DevCypherExecutor(new DevModelWriter(language), () => language.GraphRevision, lock)
        return await executor.Execute(
            { cypher: ExecutorFixture.Create, parameters: new Map(), timeoutMs: 5000, maxVarLength: 8 },
            { member: { Storage: storage }, identity: { model: 'sol', version: '0.0.0', namespace: 'shop' } },
            new OpenDevWriteSecurity())
    }

    public static Storage(): MemoryStorage
    {
        const storage = new MemoryStorage()
        storage.Files.set('model.todl', ExecutorFixture.Model)
        return storage
    }
}

test('a write holds the tenant lease across the whole write and releases it', async () =>
{
    const lock = new ScriptedLock(false, true)
    const storage = LockFixture.Storage()
    const result = await LockFixture.Run(lock, storage)
    assert.equal(result.status, AppWriteStatus.Applied)
    assert.deepEqual([lock.Acquired, lock.Released], [1, 1])
    assert.ok([...storage.Files.values()].some(text => text.includes('Bo')), JSON.stringify([...storage.Files]))
})

test('a lease held elsewhere is an in-band Conflict and nothing persists', async () =>
{
    const storage = LockFixture.Storage()
    const result = await LockFixture.Run(new ScriptedLock(true, true), storage)
    assert.equal(result.status, AppWriteStatus.Conflict)
    assert.equal(result.reason, 'another write to this tenant is in progress')
    assert.deepEqual([...storage.Files], [['model.todl', ExecutorFixture.Model]])
})

test('a lease lost before the persist (fencing) is a Conflict, nothing persists, and the lease is released', async () =>
{
    const lock = new ScriptedLock(false, false)
    const storage = LockFixture.Storage()
    const result = await LockFixture.Run(lock, storage)
    assert.equal(result.status, AppWriteStatus.Conflict)
    assert.equal(result.reason, 'the tenant write lease was lost before the write could persist')
    assert.deepEqual([...storage.Files], [['model.todl', ExecutorFixture.Model]])
    assert.equal(lock.Released, 1)
})

test('the in-process lock hands out one lease at a time, in arrival order', async () =>
{
    const lock = new InProcessWriteLock()
    const order: string[] = []
    const first = await lock.Acquire()
    const second = lock.Acquire().then(lease => { order.push('second'); return lease })
    await new Promise(resolve => setTimeout(resolve, 10))
    order.push('first-release')
    await first.Release()
    assert.equal(await first.Held(), false)
    const lease = await second
    assert.deepEqual(order, ['first-release', 'second'])
    assert.equal(await lease.Held(), true)
    await lease.Release()
})
