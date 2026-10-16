import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EnvironmentRegistry } from '../environment-registry.js'
import { EnvStatus, Template, type EnvironmentRecord, type IContainerProbe } from '../environment-record.js'
import { PortAllocator, PortUnavailableError, type IPortProbe } from '../port-allocator.js'
import { EnvironmentService, EnvironmentExistsError, EnvironmentNotFoundError, ImageMissingError, DockerUnavailableError, CreateFailedError } from '../environment-service.js'
import type { IDockerEnv, IBundleBuilder, IUserSeeder } from '../docker-env-port.js'
import type { EnvDefinition } from '../../../environments/seed/bundle.js'
import type { UserSeed } from '../../../environments/seed/users.js'

class Fixture
{
    public static readonly SecretKeys = ['contoso-admin-pw', 'rep-boston-pw', 'rep-atlanta-pw', 'manager-north-pw', 'finance-pw']
}

class FakeProbe implements IContainerProbe
{
    public async Running(): Promise<boolean>
    {
        return true
    }
}

class FakePortProbe implements IPortProbe
{
    public async Free(): Promise<boolean>
    {
        return true
    }
}

class FakeAllocator extends PortAllocator
{
    public constructor(private readonly calls: string[], private readonly busy = false)
    {
        super(9000, new FakePortProbe())
    }

    public override async Allocate(taken: readonly number[]): Promise<number>
    {
        this.calls.push('allocate')
        return 9100
    }

    public override async Check(port: number, taken: readonly number[]): Promise<void>
    {
        this.calls.push('check')
        if (this.busy)
        {
            throw new PortUnavailableError('busy')
        }
    }
}

class FakeDocker implements IDockerEnv
{
    public ImageOk = true
    public DaemonDown = false
    public FailUp = false
    public FailDown = false

    public constructor(private readonly calls: string[])
    {
    }

    public async EnsureImage(): Promise<boolean>
    {
        this.calls.push('ensureImage')
        if (this.DaemonDown)
        {
            throw new Error('daemon down')
        }
        return this.ImageOk
    }

    public async Up(): Promise<void>
    {
        this.calls.push('up')
        if (this.FailUp)
        {
            throw new Error('boom')
        }
    }

    public async Down(): Promise<void>
    {
        this.calls.push('down')
        if (this.FailDown)
        {
            throw new Error('down failed')
        }
    }

    public async Logs(): Promise<string>
    {
        this.calls.push('logs')
        return 'log-text'
    }

    public async WaitHealthy(): Promise<void>
    {
        this.calls.push('waitHealthy')
    }

    public async Running(): Promise<boolean>
    {
        return true
    }

    public async RemoveVolume(): Promise<void>
    {
        this.calls.push('removeVolume')
    }

    public BuildCommand(): string
    {
        return 'docker build ...'
    }
}

class FakeBundle implements IBundleBuilder
{
    public Args: { def: EnvDefinition; bundleDir: string; seedDir?: string } | undefined

    public constructor(private readonly calls: string[])
    {
    }

    public async Generate(def: EnvDefinition, bundleDir: string, seedDir?: string): Promise<void>
    {
        this.calls.push('generate')
        this.Args = { def, bundleDir, seedDir }
        await mkdir(bundleDir, { recursive: true })
        const secrets: Record<string, string> = {}
        for (const key of Fixture.SecretKeys)
        {
            secrets[key] = `pw-${key}`
        }
        await writeFile(join(bundleDir, 'provisioned-secrets.json'), JSON.stringify(secrets))
    }
}

class FakeSeeder implements IUserSeeder
{
    public Seeded: UserSeed[] = []

    public constructor(private readonly calls: string[])
    {
    }

    public async Login(): Promise<string>
    {
        this.calls.push('login')
        return 'tok'
    }

    public async Connect(): Promise<unknown>
    {
        this.calls.push('connect')
        return {}
    }

    public async SeedUsers(conn: unknown, users: UserSeed[]): Promise<void>
    {
        this.calls.push('seedUsers')
        this.Seeded = users
    }

    public Dispose(): void
    {
        this.calls.push('dispose')
    }
}

class RecordingRegistry extends EnvironmentRegistry
{
    public constructor(path: string, probe: IContainerProbe, private readonly calls: string[])
    {
        super(path, probe)
    }

    public override async Put(record: EnvironmentRecord): Promise<void>
    {
        this.calls.push(`put:${record.status}`)
        await super.Put(record)
    }
}

class Harness
{
    public readonly Calls: string[] = []
    public readonly Docker = new FakeDocker(this.Calls)
    public readonly Bundle = new FakeBundle(this.Calls)
    public readonly Seeder = new FakeSeeder(this.Calls)
    public Registry!: EnvironmentRegistry
    public Service!: EnvironmentService
    public DataRoot = ''

    public static async Make(busy = false): Promise<Harness>
    {
        const h = new Harness()
        const dir = await mkdtemp(join(tmpdir(), 'envsvc-'))
        h.DataRoot = join(dir, 'data')
        h.Registry = new RecordingRegistry(join(dir, 'envs.json'), new FakeProbe(), h.Calls)
        await h.Registry.Load()
        h.Service = new EnvironmentService(h.Registry, new FakeAllocator(h.Calls, busy), h.Docker, h.Bundle, h.Seeder, h.DataRoot)
        return h
    }

    public static Record(name: string, status: EnvStatus): EnvironmentRecord
    {
        return { name, template: Template.DevBlank, tenantId: name, hostPort: 9200, containerName: `pragmatic-env-${name}`, volumeName: `pragmatic-env-${name}-data`, bundleDir: `/b/${name}`, createdAt: '2026-10-16T00:00:00.000Z', status }
    }
}

test('Create demo runs the full ordered flow and persists a Running record', async () =>
{
    const h = await Harness.Make()
    const rec = await h.Service.Create('demo1', Template.DemoContoso)
    assert.deepEqual(h.Calls, ['allocate', 'generate', 'ensureImage', 'up', 'waitHealthy', 'login', 'connect', 'seedUsers', 'dispose', 'put:running'])
    assert.equal(h.Bundle.Args?.bundleDir, join(h.DataRoot, 'demo1'))
    assert.ok(h.Bundle.Args?.seedDir)
    assert.equal(h.Seeder.Seeded.length, 4)
    assert.equal(h.Seeder.Seeded[0].password, 'pw-rep-boston-pw')
    const got = h.Registry.Get('demo1')
    assert.deepEqual(got, rec)
    assert.equal(got?.status, EnvStatus.Running)
    assert.equal(got?.hostPort, 9100)
    assert.equal(got?.containerName, 'pragmatic-env-demo1')
    assert.equal(got?.volumeName, 'pragmatic-env-demo1-data')
    assert.equal(got?.tenantId, 'contoso')
})

test('Create dev skips user seeding', async () =>
{
    const h = await Harness.Make()
    const rec = await h.Service.Create('dev1', Template.DevBlank)
    assert.deepEqual(h.Calls, ['allocate', 'generate', 'ensureImage', 'up', 'waitHealthy', 'put:running'])
    assert.equal(rec.status, EnvStatus.Running)
})

test('Create duplicate throws before any docker or port call', async () =>
{
    const h = await Harness.Make()
    await h.Registry.Put(Harness.Record('dup', EnvStatus.Stopped))
    h.Calls.length = 0
    h.Calls.length = 0
    await assert.rejects(() => h.Service.Create('dup', Template.DevBlank), EnvironmentExistsError)
    assert.deepEqual(h.Calls, [])
})

test('Create with missing image throws ImageMissingError and never calls Up', async () =>
{
    const h = await Harness.Make()
    h.Docker.ImageOk = false
    await assert.rejects(() => h.Service.Create('a', Template.DevBlank), (e: unknown) => e instanceof ImageMissingError && e.buildCommand.length > 0)
    assert.ok(!h.Calls.includes('up'))
})

test('Create with daemon down throws DockerUnavailableError and never calls Up', async () =>
{
    const h = await Harness.Make()
    h.Docker.DaemonDown = true
    await assert.rejects(() => h.Service.Create('a', Template.DevBlank), (e: unknown) => e instanceof DockerUnavailableError && /docker/i.test(e.message))
    assert.ok(!h.Calls.includes('up'))
})

test('Create rolls back when Up fails', async () =>
{
    const h = await Harness.Make()
    h.Docker.FailUp = true
    await assert.rejects(() => h.Service.Create('a', Template.DevBlank), CreateFailedError)
    assert.equal(h.Calls.filter(c => c === 'down').length, 1)
    assert.equal(h.Registry.Get('a')?.status, EnvStatus.Failed)
})

test('Create still records Failed and throws CreateFailedError when rollback Down throws', async () =>
{
    const h = await Harness.Make()
    h.Docker.FailUp = true
    h.Docker.FailDown = true
    await assert.rejects(() => h.Service.Create('a', Template.DevBlank), CreateFailedError)
    assert.equal(h.Registry.Get('a')?.status, EnvStatus.Failed)
})

test('Start unknown throws; Start known brings it up Running', async () =>
{
    const h = await Harness.Make()
    await assert.rejects(() => h.Service.Start('x'), EnvironmentNotFoundError)
    await h.Registry.Put(Harness.Record('s1', EnvStatus.Stopped))
    const rec = await h.Service.Start('s1')
    assert.ok(h.Calls.includes('up') && h.Calls.includes('waitHealthy'))
    assert.equal(rec.status, EnvStatus.Running)
    assert.equal(h.Registry.Get('s1')?.status, EnvStatus.Running)
})

test('Stop calls Down and marks Stopped', async () =>
{
    const h = await Harness.Make()
    await h.Registry.Put(Harness.Record('s1', EnvStatus.Running))
    h.Calls.length = 0
    const rec = await h.Service.Stop('s1')
    assert.deepEqual(h.Calls, ['down', 'put:stopped'])
    assert.equal(rec.status, EnvStatus.Stopped)
    assert.equal(h.Registry.Get('s1')?.status, EnvStatus.Stopped)
})

test('Delete downs, removes volume, and unregisters', async () =>
{
    const h = await Harness.Make()
    await h.Registry.Put(Harness.Record('s1', EnvStatus.Running))
    h.Calls.length = 0
    await h.Service.Delete('s1')
    assert.deepEqual(h.Calls, ['down', 'removeVolume'])
    assert.equal(h.Service.List().length, 0)
})

test('user-supplied busy port propagates before any docker call', async () =>
{
    const h = await Harness.Make(true)
    await assert.rejects(() => h.Service.Create('a', Template.DevBlank, 9300), PortUnavailableError)
    assert.deepEqual(h.Calls, ['check'])
})
