import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EnvStatus, EnvType, Template, type EnvironmentRecord } from '../environment-record.js'
import { EnvironmentNotFoundError } from '../environment-service.js'
import { GraphRegistry } from '../graph-registry.js'
import { GraphService, GraphExistsError, GraphNotFoundError, GraphNameInvalidError, EnvironmentNotDevelopmentError, type IEnvironmentLookup } from '../graph-service.js'

class Fixture
{
    public static readonly TempPrefix = 'graph-service-'
    public static readonly GraphsFile = 'graphs.json'
    public static readonly Dev1 = 'dev1'
    public static readonly DevA = 'a'
    public static readonly DevB = 'b'
    public static readonly G1 = 'g1'
    public static readonly G2 = 'g2'
    public static readonly Description = 'first'
    public static readonly BadName = 'Bad Name'
    public static readonly Missing = 'missing'

    public static async TempDir(): Promise<string>
    {
        return mkdtemp(join(tmpdir(), Fixture.TempPrefix))
    }

    public static Record(name: string, type: EnvType, bundleDir: string): EnvironmentRecord
    {
        return {
            name,
            type,
            template: Template.DevBlank,
            tenantId: name,
            hostPort: 9100,
            containerName: name,
            volumeName: name,
            bundleDir,
            createdAt: new Date().toISOString(),
            status: EnvStatus.Running
        }
    }
}

class FakeLookup implements IEnvironmentLookup
{
    private readonly records = new Map<string, EnvironmentRecord>()

    public Add(record: EnvironmentRecord): void
    {
        this.records.set(record.name, record)
    }

    public Get(name: string): EnvironmentRecord | undefined
    {
        return this.records.get(name)
    }
}

test('Create persists a graph with an empty manifest in a Development environment', async () =>
{
    const dir = await Fixture.TempDir()
    const lookup = new FakeLookup()
    lookup.Add(Fixture.Record(Fixture.Dev1, EnvType.Development, dir))
    const svc = new GraphService(lookup)
    await svc.Create(Fixture.Dev1, Fixture.G1, Fixture.Description)
    const reloaded = new GraphRegistry(join(dir, Fixture.GraphsFile))
    await reloaded.Load()
    const rec = reloaded.Get(Fixture.G1)
    assert.ok(rec)
    assert.equal(rec.manifest.name, Fixture.G1)
    assert.equal(rec.manifest.description, Fixture.Description)
    assert.deepEqual(rec.manifest.packages, [])
})

test('Create against a Runtime environment is rejected', async () =>
{
    const dir = await Fixture.TempDir()
    const lookup = new FakeLookup()
    lookup.Add(Fixture.Record(Fixture.Dev1, EnvType.Runtime, dir))
    const svc = new GraphService(lookup)
    await assert.rejects(svc.Create(Fixture.Dev1, Fixture.G1, ''), EnvironmentNotDevelopmentError)
})

test('Create against an unknown environment is rejected', async () =>
{
    const svc = new GraphService(new FakeLookup())
    await assert.rejects(svc.Create(Fixture.Missing, Fixture.G1, ''), EnvironmentNotFoundError)
})

test('a duplicate graph name in the same environment is rejected', async () =>
{
    const dir = await Fixture.TempDir()
    const lookup = new FakeLookup()
    lookup.Add(Fixture.Record(Fixture.Dev1, EnvType.Development, dir))
    const svc = new GraphService(lookup)
    await svc.Create(Fixture.Dev1, Fixture.G1, '')
    await assert.rejects(svc.Create(Fixture.Dev1, Fixture.G1, ''), GraphExistsError)
})

test('the same graph name in a different environment is allowed', async () =>
{
    const lookup = new FakeLookup()
    lookup.Add(Fixture.Record(Fixture.DevA, EnvType.Development, await Fixture.TempDir()))
    lookup.Add(Fixture.Record(Fixture.DevB, EnvType.Development, await Fixture.TempDir()))
    const svc = new GraphService(lookup)
    await svc.Create(Fixture.DevA, Fixture.G1, '')
    await svc.Create(Fixture.DevB, Fixture.G1, '')
    assert.equal((await svc.List(Fixture.DevA)).length, 1)
    assert.equal((await svc.List(Fixture.DevB)).length, 1)
})

test('an invalid graph name is rejected', async () =>
{
    const dir = await Fixture.TempDir()
    const lookup = new FakeLookup()
    lookup.Add(Fixture.Record(Fixture.Dev1, EnvType.Development, dir))
    const svc = new GraphService(lookup)
    await assert.rejects(svc.Create(Fixture.Dev1, Fixture.BadName, ''), GraphNameInvalidError)
})

test('List is scoped to the environment; Delete removes', async () =>
{
    const dir = await Fixture.TempDir()
    const lookup = new FakeLookup()
    lookup.Add(Fixture.Record(Fixture.Dev1, EnvType.Development, dir))
    const svc = new GraphService(lookup)
    await svc.Create(Fixture.Dev1, Fixture.G1, '')
    await svc.Create(Fixture.Dev1, Fixture.G2, '')
    assert.equal((await svc.List(Fixture.Dev1)).length, 2)
    await svc.Delete(Fixture.Dev1, Fixture.G1)
    assert.equal((await svc.List(Fixture.Dev1)).length, 1)
    await assert.rejects(svc.Get(Fixture.Dev1, Fixture.G1), GraphNotFoundError)
})
