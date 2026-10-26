import { test } from 'node:test'
import { randomBytes } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EnvironmentRegistry } from '../environment-registry.js'
import { EnvStatus, EnvType, EnvironmentChangeKind, Template, type EnvironmentChange, type EnvironmentRecord, type IContainerProbe } from '../environment-record.js'
import { PortAllocator, PortUnavailableError, type IPortProbe } from '../port-allocator.js'
import { EnvironmentService, EnvironmentNotDevelopmentError, EnvironmentNotRuntimeError, EnvironmentExistsError, EnvironmentNotFoundError, ImageMissingError, DockerUnavailableError, CreateFailedError } from '../environment-service.js'
import { ClientRegistry } from '../client-registry.js'
import { TenantRegistry } from '../tenant-registry.js'
import { HiveRegistry } from '../hive-registry.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import { DevCa, IdpTlsMaterial } from '../../../src/idp/dev-ca.js'
import { IdpAdminEndpoint } from '../../../src/idp/idp-admin-endpoint.js'
import { IdpClientStore } from '../../../src/idp/idp-client-store.js'
import { IdpHost, IdpRealmSet } from '../../../src/idp/idp-host.js'
import { IdpRealm } from '../../../src/idp/idp-realm.js'
import { IdpSigningKey } from '../../../src/idp/idp-signing-key.js'
import { IdpSsoSessionStore } from '../../../src/idp/idp-sso-session.js'
import { InMemoryAuthorizationCodeStore } from '../../../src/idp/authorization-code-store.js'
import { IdpAdminClient } from '../idp-admin-client.js'
import type { IdpConnection, IIdpService } from '../idp-service.js'
import { PlatformDirectory } from '../platform-directory.js'
import { HivePlacementError } from '../hive-placement-error.js'
import { UnknownHiveError } from '../rollout-errors.js'
import type { ILogProcess } from '../../../environments/seed/docker.js'
import type { IDockerEnv, IBundleBuilder, IUserSeeder } from '../docker-env-port.js'
import { DockerEnvironmentRuntime } from '../environment-runtime.js'
import type { IEnvironmentRuntime, EnvEndpoint, EnvRuntimeContext } from '../environment-runtime.js'
import { EnvironmentRuntimeResolver } from '../environment-runtime-resolver.js'
import { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import { UnsupportedBackendError } from '../hive-orchestrator.js'
import { TenantPurposeName, type EnvDefinition, type EnvOidc } from '../../../environments/seed/bundle.js'
import type { UserSeed } from '../../../environments/seed/users.js'
import type { IAdminProxy, AdminConnectInfo, AdminSnapshot } from '../admin-proxy.js'
import type { CreateAccountParams, GrantMutationDto, IdentityConfigDto, IssueTokenParams, TokenIssuedDto } from '@pragmatic-tech-ai/pragmatic-protocol'

/**
 * Routes every record (bound or not) to the one Docker fake, preserving the pre-resolver service tests. The real
 * directory + orchestrator factory are still passed so the resolver's eager backend validation runs against the
 * actual hive records (a bound env on a supported Local/Attach hive validates and routes to the fake).
 */
class SingleBackendResolver
{
    public static Of(runtime: IEnvironmentRuntime, directory: PlatformDirectory, orchestrators: HiveOrchestratorFactory): EnvironmentRuntimeResolver
    {
        return new EnvironmentRuntimeResolver(runtime, runtime, directory, orchestrators)
    }
}

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

    public CaHostPath: string | undefined

    public async Up(_def?: EnvDefinition, _bundleDir?: string, caHostPath?: string): Promise<void>
    {
        this.calls.push('up')
        this.CaHostPath = caHostPath
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

    public LogDef: EnvDefinition | undefined
    public LogSink: ((chunk: string) => void) | undefined
    public readonly Process: ILogProcess = { OnData() {}, OnClose() {}, Kill() {} }

    public LogStream(def: EnvDefinition, onData: (chunk: string) => void): ILogProcess
    {
        this.calls.push('logStream')
        this.LogDef = def
        this.LogSink = onData
        return this.Process
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
    public Oidc: EnvOidc | undefined

    public constructor(private readonly calls: string[])
    {
    }

    public async Generate(def: EnvDefinition, bundleDir: string, seedDir?: string, oidc?: EnvOidc): Promise<void>
    {
        this.calls.push('generate')
        this.Oidc = oidc
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

/** An in-cluster-shaped runtime (publishes no host port) that records the ctx handed to Start, to observe CtxOf. */
class CtxRecordingRuntime implements IEnvironmentRuntime
{
    public StartCtx: EnvRuntimeContext | undefined
    private static readonly Endpoint: EnvEndpoint = { httpUrl: 'http://svc', wsUrl: 'ws://svc' }
    private static readonly Process: ILogProcess = { OnData() {}, OnClose() {}, Kill() {} }

    public PublishesHostPort(): boolean { return false }
    public EnsureImage(): Promise<boolean> { return Promise.resolve(true) }
    public BuildCommand(): string { return '' }
    public Prepare(): Promise<void> { return Promise.resolve() }
    public BringUp(): Promise<EnvEndpoint> { return Promise.resolve(CtxRecordingRuntime.Endpoint) }
    public WaitHealthy(): Promise<void> { return Promise.resolve() }
    public Start(ctx: EnvRuntimeContext): Promise<EnvEndpoint> { this.StartCtx = ctx; return Promise.resolve(CtxRecordingRuntime.Endpoint) }
    public Stop(): Promise<void> { return Promise.resolve() }
    public Teardown(): Promise<void> { return Promise.resolve() }
    public RemoveVolume(): Promise<void> { return Promise.resolve() }
    public Logs(): Promise<string> { return Promise.resolve('') }
    public LogStream(): ILogProcess { return CtxRecordingRuntime.Process }
    public Probe(): Promise<boolean> { return Promise.resolve(true) }
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

class FakeAdminProxy implements IAdminProxy
{
    public Calls: { method: string; info: AdminConnectInfo; args: unknown[] }[] = []
    public Snapshot = { accounts: [], grants: [], config: {} } as unknown as AdminSnapshot
    public Config = { marker: 'cfg' } as unknown as IdentityConfigDto

    public async LoadAdmin(info: AdminConnectInfo): Promise<AdminSnapshot>
    {
        this.Calls.push({ method: 'LoadAdmin', info, args: [] })
        return this.Snapshot
    }

    public async CreateAccount(info: AdminConnectInfo, params: CreateAccountParams): Promise<void>
    {
        this.Calls.push({ method: 'CreateAccount', info, args: [params] })
    }

    public async DisableAccount(info: AdminConnectInfo, principalId: string): Promise<void>
    {
        this.Calls.push({ method: 'DisableAccount', info, args: [principalId] })
    }

    public async GrantRole(info: AdminConnectInfo, mutation: GrantMutationDto): Promise<void>
    {
        this.Calls.push({ method: 'GrantRole', info, args: [mutation] })
    }

    public async RevokeRole(info: AdminConnectInfo, mutation: GrantMutationDto): Promise<void>
    {
        this.Calls.push({ method: 'RevokeRole', info, args: [mutation] })
    }

    public async GetConfig(info: AdminConnectInfo): Promise<IdentityConfigDto>
    {
        this.Calls.push({ method: 'GetConfig', info, args: [] })
        return this.Config
    }

    public async GetSecurityModel(info: AdminConnectInfo): Promise<any>
    {
        this.Calls.push({ method: 'GetSecurityModel', info, args: [] })
        return { roles: [] }
    }

    public async SetSecurityModel(info: AdminConnectInfo, model: any): Promise<void>
    {
        this.Calls.push({ method: 'SetSecurityModel', info, args: [model] })
    }

    public async CreateGraph(_info: AdminConnectInfo, _p: any): Promise<any>
    {
        throw new Error('unused')
    }

    public async ListGraphs(_info: AdminConnectInfo): Promise<any[]>
    {
        throw new Error('unused')
    }

    public async GetGraph(_info: AdminConnectInfo, _p: any): Promise<any>
    {
        throw new Error('unused')
    }

    public async DeleteGraph(_info: AdminConnectInfo, _p: any): Promise<void>
    {
        throw new Error('unused')
    }

    public async ExportGraph(_info: AdminConnectInfo, _p: any): Promise<any>
    {
        throw new Error('unused')
    }

    public async LoadGraph(_info: AdminConnectInfo, _p: any): Promise<any>
    {
        throw new Error('unused')
    }

    public async GetLoadedGraph(_info: AdminConnectInfo): Promise<any>
    {
        throw new Error('unused')
    }

    public async IssueToken(info: AdminConnectInfo, params: IssueTokenParams): Promise<TokenIssuedDto>
    {
        this.Calls.push({ method: 'IssueToken', info, args: [params] })
        return { tokenRef: 'ref', token: 'secret-token', principalId: params.principalId, scopes: params.scopes, expiresAt: 'later' } as unknown as TokenIssuedDto
    }

    public async SetConfig(info: AdminConnectInfo, config: IdentityConfigDto): Promise<void>
    {
        this.Calls.push({ method: 'SetConfig', info, args: [config] })
    }
}

class FakeIdp implements IIdpService
{
    public Calls: Array<{ tenantId: string; displayName: string }> = []

    public constructor(private readonly conn: IdpConnection | Error)
    {
    }

    public async EnsureForTenant(tenantId: string, displayName: string): Promise<IdpConnection>
    {
        this.Calls.push({ tenantId, displayName })
        if (this.conn instanceof Error)
        {
            throw this.conn
        }
        return this.conn
    }
}

class IdpFixture
{
    public static readonly Token = 'admin-token-for-env-tests'

    /** Runs body against an in-process IdP (host + admin endpoint + dev CA) that already has the realm for tenantId. */
    public static async With(tenantId: string, body: (conn: IdpConnection, clients: IdpClientStore) => Promise<void>): Promise<void>
    {
        const dir = await mkdtemp(join(tmpdir(), 'envsvc-idp-'))
        let host: IdpHost | undefined
        try
        {
            const key = await IdpSigningKey.LoadOrCreate(join(dir, 'idp-signing.pem'))
            const ca = DevCa.EnsureAt(join(dir, 'ca'), 'localhost')
            const tls = IdpTlsMaterial.Load({ certFile: ca.certFile, keyFile: ca.keyFile })
            const realmsDir = join(dir, 'realms')
            const realms = new IdpRealmSet([], (id, name) => IdpRealm.OpenFor(realmsDir, id, name, randomBytes(32)))
            const clients = new IdpClientStore()
            const admin = new IdpAdminEndpoint(IdpFixture.Token, realms, clients)
            host = new IdpHost('https://localhost', key, realms, clients, new InMemoryAuthorizationCodeStore(), new IdpSsoSessionStore(), tls, true, admin)
            await host.Listen(0, '127.0.0.1')
            const conn: IdpConnection = {
                baseUrl: 'https://localhost:' + host.Address().port,
                browserBaseUrl: 'https://localhost:' + host.Address().port,
                ca: readFileSync(ca.caFile),
                adminToken: IdpFixture.Token,
                adminTokenRef: 'admin-token',
                caDir: '/data/idp/' + tenantId + '/tls'
            }
            await new IdpAdminClient(conn).EnsureRealm(tenantId, 'T')
            await body(conn, clients)
        }
        finally
        {
            if (host !== undefined)
            {
                await host.Close()
            }
            rmSync(dir, { recursive: true, force: true })
        }
    }
}

class Harness
{
    public readonly Proxy = new FakeAdminProxy()
    public readonly Calls: string[] = []
    public readonly Docker = new FakeDocker(this.Calls)
    public readonly Bundle = new FakeBundle(this.Calls)
    public readonly Seeder = new FakeSeeder(this.Calls)
    public Registry!: EnvironmentRegistry
    public Service!: EnvironmentService
    public DataRoot = ''
    public Directory!: PlatformDirectory
    public Idp: IIdpService = new FakeIdp(new Error('no idp in this test'))

    public static async Make(busy = false): Promise<Harness>
    {
        const h = new Harness()
        const dir = await mkdtemp(join(tmpdir(), 'envsvc-'))
        h.DataRoot = join(dir, 'data')
        h.Registry = new RecordingRegistry(join(dir, 'envs.json'), new FakeProbe(), h.Calls)
        await h.Registry.Load()
        h.Directory = new PlatformDirectory(
            new ClientRegistry(join(dir, 'clients.json')),
            new TenantRegistry(join(dir, 'tenants.json')),
            new HiveRegistry(join(dir, 'hives.json')),
            h.Registry)
        await h.Directory.Load()
        await h.Directory.CreateClient({ id: 'c1', displayName: 'C1' })
        await h.Directory.CreateTenant({ id: 'plat-t1', clientId: 'c1', displayName: 'T1' })
        await h.Directory.CreateTenant({ id: 'plat-t2', clientId: 'c1', displayName: 'T2' })
        await h.Directory.CreateHive({
            id: 'h1', tenantId: 'plat-t1', displayName: 'H1',
            cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach, configRef: 'kube-ref' },
            registry: { mode: InfraMode.Attach, endpoint: 'reg.local', credentialRef: 'cred-ref' }
        })
        h.Service = new EnvironmentService(h.Registry, new FakeAllocator(h.Calls, busy), SingleBackendResolver.Of(new DockerEnvironmentRuntime(h.Docker, h.Bundle), h.Directory, new HiveOrchestratorFactory()), h.Seeder, h.DataRoot, h.Proxy, h.Directory, h.Idp, c => new IdpAdminClient(c))
        return h
    }

    /** Rebuilds the service over a different IdP seam (shares registry, docker, bundle, directory). */
    public UseIdp(idp: IIdpService): void
    {
        this.Idp = idp
        this.Service = new EnvironmentService(this.Registry, new FakeAllocator(this.Calls, false), SingleBackendResolver.Of(new DockerEnvironmentRuntime(this.Docker, this.Bundle), this.Directory, new HiveOrchestratorFactory()), this.Seeder, this.DataRoot, this.Proxy, this.Directory, idp, c => new IdpAdminClient(c))
    }

    public static Record(name: string, status: EnvStatus): EnvironmentRecord
    {
        return { name, template: Template.DevBlank, environmentId: name, hostPort: 9200, type: EnvType.Development, containerName: `pragmatic-env-${name}`, volumeName: `pragmatic-env-${name}-data`, bundleDir: `/b/${name}`, createdAt: '2026-10-16T00:00:00.000Z', status }
    }
}

test('Create demo runs the full ordered flow and persists a Running record', async () =>
{
    const h = await Harness.Make()
    const rec = await h.Service.Create('demo1', Template.DemoContoso, EnvType.Runtime)
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
    assert.equal(got?.environmentId, 'contoso')
})

test('Create dev skips user seeding', async () =>
{
    const h = await Harness.Make()
    const rec = await h.Service.Create('dev1', Template.DevBlank, EnvType.Development)
    assert.deepEqual(h.Calls, ['allocate', 'generate', 'ensureImage', 'up', 'waitHealthy', 'put:running'])
    assert.equal(rec.status, EnvStatus.Running)
})

test('Create duplicate throws before any docker or port call', async () =>
{
    const h = await Harness.Make()
    await h.Registry.Put(Harness.Record('dup', EnvStatus.Stopped))
    h.Calls.length = 0
    await assert.rejects(() => h.Service.Create('dup', Template.DevBlank, EnvType.Development), EnvironmentExistsError)
    assert.deepEqual(h.Calls, [])
})

test('Create with missing image throws ImageMissingError and never calls Up', async () =>
{
    const h = await Harness.Make()
    h.Docker.ImageOk = false
    await assert.rejects(() => h.Service.Create('a', Template.DevBlank, EnvType.Development), (e: unknown) => e instanceof ImageMissingError && e.buildCommand.length > 0)
    assert.ok(!h.Calls.includes('up'))
})

test('Create with daemon down throws DockerUnavailableError and never calls Up', async () =>
{
    const h = await Harness.Make()
    h.Docker.DaemonDown = true
    await assert.rejects(() => h.Service.Create('a', Template.DevBlank, EnvType.Development), (e: unknown) => e instanceof DockerUnavailableError && /docker/i.test(e.message))
    assert.ok(!h.Calls.includes('up'))
})

test('Create rolls back when Up fails', async () =>
{
    const h = await Harness.Make()
    h.Docker.FailUp = true
    await assert.rejects(() => h.Service.Create('a', Template.DevBlank, EnvType.Development), CreateFailedError)
    assert.equal(h.Calls.filter(c => c === 'down').length, 1)
    assert.equal(h.Registry.Get('a')?.status, EnvStatus.Failed)
})

test('Create still records Failed and throws CreateFailedError when rollback Down throws', async () =>
{
    const h = await Harness.Make()
    h.Docker.FailUp = true
    h.Docker.FailDown = true
    await assert.rejects(() => h.Service.Create('a', Template.DevBlank, EnvType.Development), CreateFailedError)
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

test('Start recovers a bundle dir from the data root when the record carries none (in-cluster regression guard)', async () =>
{
    const h = await Harness.Make()
    const runtime = new CtxRecordingRuntime()
    h.Service = new EnvironmentService(h.Registry, new FakeAllocator(h.Calls, false), SingleBackendResolver.Of(runtime, h.Directory, new HiveOrchestratorFactory()), h.Seeder, h.DataRoot, h.Proxy, h.Directory, h.Idp, c => new IdpAdminClient(c))
    const record = Harness.Record('s1', EnvStatus.Stopped)
    delete (record as { bundleDir?: string }).bundleDir
    await h.Registry.Put(record)
    await h.Service.Start('s1')
    assert.equal(runtime.StartCtx?.bundleDir, join(h.DataRoot, 's1'))
})

test('a throwing OnChanged subscriber neither fails Start nor blocks later subscribers', async () =>
{
    const h = await Harness.Make()
    await h.Registry.Put(Harness.Record('s1', EnvStatus.Stopped))
    const received: EnvironmentChange[] = []
    h.Service.OnChanged(() =>
    {
        throw new Error('subscriber boom')
    })
    h.Service.OnChanged(change => received.push(change))
    const rec = await h.Service.Start('s1')
    assert.equal(rec.status, EnvStatus.Running)
    assert.equal(received.length, 1)
    assert.equal(received[0].kind, EnvironmentChangeKind.Changed)
    assert.equal(received[0].record.status, EnvStatus.Running)
})

test('Create fires a Created change carrying the new record', async () =>
{
    const h = await Harness.Make()
    const received: EnvironmentChange[] = []
    h.Service.OnChanged(change => received.push(change))
    const rec = await h.Service.Create('dev1', Template.DevBlank, EnvType.Development)
    assert.equal(received.length, 1)
    assert.equal(received[0].kind, EnvironmentChangeKind.Created)
    assert.equal(received[0].record.name, rec.name)
    assert.equal(received[0].record.status, EnvStatus.Running)
})

test('a failed Create fires a Created change carrying the Failed record', async () =>
{
    const h = await Harness.Make()
    h.Docker.FailUp = true
    const received: EnvironmentChange[] = []
    h.Service.OnChanged(change => received.push(change))
    await assert.rejects(() => h.Service.Create('a', Template.DevBlank, EnvType.Development), CreateFailedError)
    assert.equal(received.length, 1)
    assert.equal(received[0].kind, EnvironmentChangeKind.Created)
    assert.equal(received[0].record.status, EnvStatus.Failed)
})

test('Delete fires a Deleted change carrying the removed record', async () =>
{
    const h = await Harness.Make()
    await h.Registry.Put(Harness.Record('s1', EnvStatus.Running))
    const received: EnvironmentChange[] = []
    h.Service.OnChanged(change => received.push(change))
    await h.Service.Delete('s1')
    assert.equal(received.length, 1)
    assert.equal(received[0].kind, EnvironmentChangeKind.Deleted)
    assert.equal(received[0].record.name, 's1')
})

test('LogStream resolves the record and delegates to docker.LogStream, forwarding chunks', async () =>
{
    const h = await Harness.Make()
    h.Registry.Put(Harness.Record('s1', EnvStatus.Running))
    const got: string[] = []
    const proc = h.Service.LogStream('s1', c => got.push(c))
    assert.equal(proc, h.Docker.Process)
    assert.equal(h.Docker.LogDef?.name, 's1')
    h.Docker.LogSink?.('hello')
    assert.deepEqual(got, ['hello'])
})

test('LogStream on unknown env throws EnvironmentNotFoundError', async () =>
{
    const h = await Harness.Make()
    assert.throws(() => h.Service.LogStream('nope', () => {}), EnvironmentNotFoundError)
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

test('Restart stops then starts (ordered) and returns a Running record', async () =>
{
    const h = await Harness.Make()
    await h.Registry.Put(Harness.Record('s1', EnvStatus.Running))
    h.Calls.length = 0
    const rec = await h.Service.Restart('s1')
    assert.deepEqual(h.Calls, ['down', 'put:stopped', 'up', 'waitHealthy', 'put:running'])
    assert.equal(rec.status, EnvStatus.Running)
    assert.equal(h.Registry.Get('s1')?.status, EnvStatus.Running)
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
    await assert.rejects(() => h.Service.Create('a', Template.DevBlank, EnvType.Development, 9300), PortUnavailableError)
    assert.deepEqual(h.Calls, ['check'])
})

class AdminFixture
{
    public static readonly Name = 'adm'
    public static readonly Password = 'owner-secret'

    public static async Seed(h: Harness, withSecret = true): Promise<void>
    {
        const bundleDir = await mkdtemp(join(tmpdir(), 'envsvc-bundle-'))
        const secrets: Record<string, string> = withSecret ? { 'adm-admin-pw': AdminFixture.Password } : {}
        await writeFile(join(bundleDir, 'provisioned-secrets.json'), JSON.stringify(secrets))
        await h.Registry.Put({ ...Harness.Record(AdminFixture.Name, EnvStatus.Running), bundleDir })
    }
}

test('AdminSnapshot builds the exact connect info from the record and stored secret', async () =>
{
    const h = await Harness.Make()
    await AdminFixture.Seed(h)
    const snap = await h.Service.AdminSnapshot(AdminFixture.Name)
    assert.equal(snap, h.Proxy.Snapshot)
    assert.equal(h.Proxy.Calls.length, 1)
    assert.equal(h.Proxy.Calls[0].method, 'LoadAdmin')
    assert.deepEqual(h.Proxy.Calls[0].info, {
        httpUrl: 'http://localhost:9200',
        wsUrl: 'ws://localhost:9200',
        tenant: 'adm',
        email: 'admin@adm.test',
        password: AdminFixture.Password
    })
})

test('other Admin methods delegate with the same info and their args', async () =>
{
    const h = await Harness.Make()
    await AdminFixture.Seed(h)
    const params = { email: 'a@b.c' } as unknown as CreateAccountParams
    const mutation = { principalId: 'p' } as unknown as GrantMutationDto
    const config = { marker: 'new' } as unknown as IdentityConfigDto
    await h.Service.AdminCreateAccount(AdminFixture.Name, params)
    await h.Service.AdminDisableAccount(AdminFixture.Name, 'p1')
    await h.Service.AdminGrantRole(AdminFixture.Name, mutation)
    await h.Service.AdminRevokeRole(AdminFixture.Name, mutation)
    const got = await h.Service.AdminGetConfig(AdminFixture.Name)
    await h.Service.AdminSetConfig(AdminFixture.Name, config)
    const model = { roles: [] } as any
    assert.deepEqual(await h.Service.AdminGetSecurityModel(AdminFixture.Name), { roles: [] })
    await h.Service.AdminSetSecurityModel(AdminFixture.Name, model)
    assert.equal(got, h.Proxy.Config)
    assert.deepEqual(h.Proxy.Calls.map(c => c.method), ['CreateAccount', 'DisableAccount', 'GrantRole', 'RevokeRole', 'GetConfig', 'SetConfig', 'GetSecurityModel', 'SetSecurityModel'])
    assert.deepEqual(h.Proxy.Calls.map(c => c.args), [[params], ['p1'], [mutation], [mutation], [], [config], [], [model]])
    for (const c of h.Proxy.Calls)
    {
        assert.equal(c.info.password, AdminFixture.Password)
        assert.equal(c.info.email, 'admin@adm.test')
    }
})

test('Admin methods on an unknown environment throw EnvironmentNotFoundError without calling the proxy', async () =>
{
    const h = await Harness.Make()
    await assert.rejects(() => h.Service.AdminSnapshot('nope'), EnvironmentNotFoundError)
    await assert.rejects(() => h.Service.AdminSetConfig('nope', {} as IdentityConfigDto), EnvironmentNotFoundError)
    assert.equal(h.Proxy.Calls.length, 0)
})

test('Admin methods throw when the admin secret is missing and never call the proxy', async () =>
{
    const h = await Harness.Make()
    await AdminFixture.Seed(h, false)
    await assert.rejects(() => h.Service.AdminSnapshot(AdminFixture.Name), /no provisioned secret for adm-admin-pw/)
    assert.equal(h.Proxy.Calls.length, 0)
})

class DefOfProbe
{
    public static Purpose(rec: EnvironmentRecord): TenantPurposeName
    {
        return ((EnvironmentService as any).DefOf(rec) as EnvDefinition).purpose
    }
}

test('Create stores the chosen type on the record', async () =>
{
    const h = await Harness.Make()
    const rec = await h.Service.Create('e1', Template.DevBlank, EnvType.Runtime)
    assert.equal(rec.type, EnvType.Runtime)
    assert.equal(h.Registry.Get('e1')?.type, EnvType.Runtime)
})

test('DefOf re-derives purpose from the stored type, not the template default', () =>
{
    const rec = { ...Harness.Record('r1', EnvStatus.Stopped), template: Template.DevBlank, type: EnvType.Runtime }
    assert.equal(DefOfProbe.Purpose(rec), TenantPurposeName.Runtime)
})

test('DefOf falls back to the template default when a legacy record has no type', () =>
{
    const rec = { ...Harness.Record('l1', EnvStatus.Stopped), template: Template.DemoContoso, type: undefined } as unknown as EnvironmentRecord
    assert.equal(DefOfProbe.Purpose(rec), TenantPurposeName.Runtime)
})

test('two overlapping Creates for the same name yield one environment and one EnvironmentExistsError', async () =>
{
    const h = await Harness.Make()
    const p1 = h.Service.Create('e1', Template.DevBlank, EnvType.Development)
    const p2 = h.Service.Create('e1', Template.DevBlank, EnvType.Development)
    const results = await Promise.allSettled([p1, p2])
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    assert.equal(rejected.length, 1)
    assert.ok(rejected[0].reason instanceof EnvironmentExistsError)
    assert.equal(h.Calls.filter(c => c === 'up').length, 1)
    assert.equal(h.Registry.List().length, 1)
})

test('a failed Create releases its in-flight reservation so the name can be retried', async () =>
{
    const h = await Harness.Make()
    h.Docker.ImageOk = false
    await assert.rejects(() => h.Service.Create('e1', Template.DevBlank, EnvType.Development), ImageMissingError)
    h.Docker.ImageOk = true
    const rec = await h.Service.Create('e1', Template.DevBlank, EnvType.Development)
    assert.equal(rec.status, EnvStatus.Running)
})

test('AdminIssueMakerToken grants Maker then issues a maker token; repeat call succeeds', async () =>
{
    const h = await Harness.Make()
    await AdminFixture.Seed(h)
    const dto = await h.Service.AdminIssueMakerToken(AdminFixture.Name)
    assert.deepEqual(h.Proxy.Calls.map(c => c.method), ['GrantRole', 'IssueToken'])
    assert.deepEqual(h.Proxy.Calls[0].args, [{ subject: 'maker', role: 'Maker', resourceKind: 'Tenant', resourcePath: [] }])
    const params = h.Proxy.Calls[1].args[0] as IssueTokenParams
    assert.equal(params.principalId, 'maker')
    assert.deepEqual(params.scopes, ['graph-contribute'])
    assert.equal(dto.token, 'secret-token')
    assert.equal(h.Proxy.Calls[0].info.password, AdminFixture.Password)
    await h.Service.AdminIssueMakerToken(AdminFixture.Name)
    assert.equal(h.Proxy.Calls.length, 4)
})

test('AdminIssueMakerToken on a non-Development env throws before any proxy call', async () =>
{
    const h = await Harness.Make()
    await AdminFixture.Seed(h)
    await h.Registry.Put({ ...h.Registry.Get(AdminFixture.Name)!, type: EnvType.Runtime })
    await assert.rejects(() => h.Service.AdminIssueMakerToken(AdminFixture.Name), EnvironmentNotDevelopmentError)
    assert.equal(h.Proxy.Calls.length, 0)
})

test('AdminGrantAppReader grants the app-reader Viewer role as Owner via the proxy; repeat call succeeds; returns no secret', async () =>
{
    const h = await Harness.Make()
    await AdminFixture.Seed(h)
    await h.Registry.Put({ ...h.Registry.Get(AdminFixture.Name)!, type: EnvType.Runtime })
    const result = await h.Service.AdminGrantAppReader(AdminFixture.Name)
    assert.equal(result, undefined)
    assert.deepEqual(h.Proxy.Calls.map(c => c.method), ['GrantRole'])
    assert.deepEqual(h.Proxy.Calls[0].args, [{ subject: 'app-reader', role: 'Viewer', resourceKind: 'Tenant', resourcePath: [] }])
    assert.equal(h.Proxy.Calls[0].info.password, AdminFixture.Password)
    await h.Service.AdminGrantAppReader(AdminFixture.Name)
    assert.equal(h.Proxy.Calls.length, 2)
})

test('AdminGrantAppReader on a non-Runtime env throws before any proxy call', async () =>
{
    const h = await Harness.Make()
    await AdminFixture.Seed(h)
    await assert.rejects(() => h.Service.AdminGrantAppReader(AdminFixture.Name), EnvironmentNotRuntimeError)
    assert.equal(h.Proxy.Calls.length, 0)
})

test('Create with a valid hiveId binds the platform tenant and hive and passes placement', async () =>
{
    await IdpFixture.With('plat-t1', async (conn) =>
    {
        const h = await Harness.Make()
        h.UseIdp(new FakeIdp(conn))
        const rec = await h.Service.Create('bound1', Template.DevBlank, EnvType.Development, undefined, 'h1')
        assert.equal(rec.tenantId, 'plat-t1')
        assert.equal(rec.hiveId, 'h1')
        assert.notEqual(rec.tenantId, rec.environmentId)
        assert.doesNotThrow(() => h.Directory.ValidateHivePlacement(rec.tenantId!, rec.hiveId!))
        assert.deepEqual(h.Registry.Get('bound1'), rec)
    })
})

test('Create with an unknown hiveId throws UnknownHiveError and creates nothing', async () =>
{
    const h = await Harness.Make()
    await assert.rejects(() => h.Service.Create('bound2', Template.DevBlank, EnvType.Development, undefined, 'nope'), UnknownHiveError)
    assert.equal(h.Registry.Get('bound2'), undefined)
    assert.deepEqual(h.Calls, [])
})

test('Create on a hive with an unsupported (cloud) backend throws UnsupportedBackendError RAW and persists no record', async () =>
{
    const h = await Harness.Make()
    await h.Directory.CreateHive({
        id: 'h-aks', tenantId: 'plat-t1', displayName: 'AKS',
        cluster: { backend: HiveBackend.Aks, mode: InfraMode.Provision },
        registry: { mode: InfraMode.Provision }
    })
    h.Calls.length = 0
    // The resolver validates the backend before any side effect: the error surfaces raw, never wrapped in CreateFailedError.
    await assert.rejects(
        () => h.Service.Create('cloud1', Template.DevBlank, EnvType.Development, undefined, 'h-aks'),
        (e: unknown) => e instanceof UnsupportedBackendError && !(e instanceof CreateFailedError))
    assert.equal(h.Registry.Get('cloud1'), undefined)
    assert.deepEqual(h.Calls, [])
})

test('Create binds the hive owner tenant, and ValidateHivePlacement rejects a different tenant', async () =>
{
    await IdpFixture.With('plat-t2', async (conn) =>
    {
        const h = await Harness.Make()
        h.UseIdp(new FakeIdp(conn))
        await h.Directory.CreateHive({
            id: 'h2', tenantId: 'plat-t2', displayName: 'H2',
            cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach, configRef: 'kube-ref' },
            registry: { mode: InfraMode.Attach, endpoint: 'reg.local', credentialRef: 'cred-ref' }
        })
        const rec = await h.Service.Create('bound3', Template.DevBlank, EnvType.Development, undefined, 'h2')
        assert.equal(rec.tenantId, 'plat-t2')
        assert.throws(() => h.Directory.ValidateHivePlacement('plat-t1', 'h2'), HivePlacementError)
    })
})

test('Create without a hiveId leaves tenantId and hiveId unset', async () =>
{
    const h = await Harness.Make()
    const rec = await h.Service.Create('unbound1', Template.DevBlank, EnvType.Development)
    assert.equal(rec.tenantId, undefined)
    assert.equal(rec.hiveId, undefined)
    assert.deepEqual(h.Calls, ['allocate', 'generate', 'ensureImage', 'up', 'waitHealthy', 'put:running'])
})

test('BOUND Create registers an OIDC client at the tenant IdP and federates the bundle and container', async () =>
{
    await IdpFixture.With('plat-t1', async (conn, clients) =>
    {
        const h = await Harness.Make()
        const idp = new FakeIdp(conn)
        h.UseIdp(idp)
        const rec = await h.Service.Create('fed1', Template.DevBlank, EnvType.Development, undefined, 'h1')
        assert.deepEqual(idp.Calls, [{ tenantId: 'plat-t1', displayName: 'T1' }])
        assert.deepEqual(h.Calls.slice(0, 3), ['allocate', 'generate', 'ensureImage'])
        const oidc = h.Bundle.Oidc
        assert.ok(oidc)
        assert.equal(oidc.issuer, conn.baseUrl + '/' + encodeURIComponent('plat-t1'))
        assert.equal(oidc.discoveryUrl, conn.baseUrl + '/plat-t1/.well-known/openid-configuration')
        assert.equal(oidc.clientId, rec.environmentId)
        assert.equal(oidc.redirectUri, 'http://localhost:9100/auth/oidc/callback?environment=' + rec.environmentId)
        assert.equal(oidc.secretRef, rec.environmentId + '-oidc-secret')
        assert.ok(oidc.secret.length >= 24)
        assert.equal(await clients.VerifySecret('plat-t1', oidc.clientId, oidc.secret), true)
        assert.equal(await clients.VerifySecret('plat-t1', oidc.clientId, oidc.secret + 'x'), false)
        // The IdP allow-lists the exact redirect_uri (environment hint included) the env server will present; the callback cannot route without it.
        assert.equal(clients.RedirectAllowed('plat-t1', oidc.clientId, oidc.redirectUri), true)
        assert.equal(clients.RedirectAllowed('plat-t1', oidc.clientId, 'http://localhost:9100/auth/oidc/callback'), false)
        assert.equal(h.Docker.CaHostPath, join(conn.caDir, 'ca.crt'))
    })
})

test('UNBOUND Create does not touch the IdP and passes no oidc or caHostPath', async () =>
{
    const h = await Harness.Make()
    const idp = new FakeIdp(new Error('must not be called'))
    h.UseIdp(idp)
    await h.Service.Create('local1', Template.DevBlank, EnvType.Development)
    assert.deepEqual(idp.Calls, [])
    assert.equal(h.Bundle.Oidc, undefined)
    assert.equal(h.Docker.CaHostPath, undefined)
})

test('BOUND Create with a failing IdP stops before generate and throws CreateFailedError', async () =>
{
    await IdpFixture.With('plat-t1', async (conn) =>
    {
        const h = await Harness.Make()
        h.UseIdp(new FakeIdp({ ...conn, adminToken: 'wrong-token' }))
        await assert.rejects(() => h.Service.Create('fedbad', Template.DevBlank, EnvType.Development, undefined, 'h1'), CreateFailedError)
        assert.equal(h.Bundle.Oidc, undefined)
        assert.ok(!h.Calls.includes('generate'))
    })
})

test('BOUND Create failure after the secret exists never leaks it in the error, logs or record', async () =>
{
    await IdpFixture.With('plat-t1', async (conn) =>
    {
        const h = await Harness.Make()
        h.UseIdp(new FakeIdp(conn))
        const original = h.Docker.Up.bind(h.Docker)
        h.Docker.Up = async (def?: EnvDefinition, dir?: string, ca?: string) =>
        {
            await original(def, dir, ca)
            throw new Error('boom ' + h.Bundle.Oidc!.secret)
        }
        const logged: string[] = []
        const origLog = console.log
        const origErr = console.error
        console.log = (...a: unknown[]) => { logged.push(a.join(' ')) }
        console.error = (...a: unknown[]) => { logged.push(a.join(' ')) }
        let thrown: unknown
        try
        {
            await h.Service.Create('fedbad2', Template.DevBlank, EnvType.Development, undefined, 'h1')
        }
        catch (e)
        {
            thrown = e
        }
        finally
        {
            console.log = origLog
            console.error = origErr
        }
        const secret = h.Bundle.Oidc!.secret
        assert.ok(thrown instanceof CreateFailedError)
        assert.ok(!(String(thrown) + thrown.message + (thrown.stack ?? '')).includes(secret))
        assert.ok(!logged.join('\n').includes(secret))
        assert.equal(h.Registry.Get('fedbad2')?.status, EnvStatus.Failed)
        assert.ok(!JSON.stringify(h.Registry.Get('fedbad2')).includes(secret))
    })
})

class DnsReachedFakeRuntime extends DockerEnvironmentRuntime
{
    private static readonly HttpUrl = 'http://svc.ns.svc.cluster.local:8080'
    private static readonly WsUrl = 'ws://svc.ns.svc.cluster.local:8080/'

    public override PublishesHostPort(): boolean
    {
        return false
    }

    public override async BringUp(): Promise<EnvEndpoint>
    {
        return { httpUrl: DnsReachedFakeRuntime.HttpUrl, wsUrl: DnsReachedFakeRuntime.WsUrl }
    }

    public override async WaitHealthy(): Promise<void>
    {
    }
}

test('Create demo on a DNS-reached (in-cluster) backend does not host-seed users and still persists Running', async () =>
{
    const h = await Harness.Make()
    // No base domain on the connection: no browser-reachable origin, so the env is not federated (and the IdP is never asked to register a client).
    const unfederated: IdpConnection = { baseUrl: 'https://idp.internal', browserBaseUrl: 'https://idp.internal', ca: Buffer.from('ca'), adminToken: 't', adminTokenRef: 'r', caDir: '/ca' }
    h.Service = new EnvironmentService(h.Registry, new FakeAllocator(h.Calls, false), SingleBackendResolver.Of(new DnsReachedFakeRuntime(h.Docker, h.Bundle), h.Directory, new HiveOrchestratorFactory()), h.Seeder, h.DataRoot, h.Proxy, h.Directory, new FakeIdp(unfederated), c => new IdpAdminClient(c))
    const rec = await h.Service.Create('demo-ic', Template.DemoContoso, EnvType.Runtime, undefined, 'h1')
    assert.equal(h.Bundle.Oidc, undefined)
    assert.equal(rec.idpBaseDomain, undefined)
    assert.ok(!h.Calls.includes('seedUsers'))
    assert.ok(!h.Calls.includes('login'))
    assert.equal(rec.status, EnvStatus.Running)
    assert.equal(rec.hostPort, undefined)
})

class ReconcileFixture
{
    public static async Seed(status: EnvStatus): Promise<{ h: Harness; received: EnvironmentChange[] }>
    {
        const h = await Harness.Make()
        await h.Registry.Put(Harness.Record('rc1', status))
        h.Calls.length = 0
        const received: EnvironmentChange[] = []
        h.Service.OnChanged(change => received.push(change))
        return { h, received }
    }
}

test('ReconcileStatus on Running with not-ready Puts Stopped once and fires one Changed event', async () =>
{
    const { h, received } = await ReconcileFixture.Seed(EnvStatus.Running)
    await h.Service.ReconcileStatus('rc1', false)
    assert.deepEqual(h.Calls.filter(c => c.startsWith('put:')), [`put:${EnvStatus.Stopped}`])
    assert.equal(received.length, 1)
    assert.equal(received[0].kind, EnvironmentChangeKind.Changed)
    assert.equal(received[0].record.status, EnvStatus.Stopped)
    assert.equal(h.Registry.Get('rc1')?.status, EnvStatus.Stopped)
})

test('ReconcileStatus on Stopped with not-ready is idempotent: no Put, no event', async () =>
{
    const { h, received } = await ReconcileFixture.Seed(EnvStatus.Stopped)
    await h.Service.ReconcileStatus('rc1', false)
    assert.deepEqual(h.Calls.filter(c => c.startsWith('put:')), [])
    assert.equal(received.length, 0)
})

test('ReconcileStatus never touches a Failed record', async () =>
{
    const { h, received } = await ReconcileFixture.Seed(EnvStatus.Failed)
    await h.Service.ReconcileStatus('rc1', true)
    assert.deepEqual(h.Calls.filter(c => c.startsWith('put:')), [])
    assert.equal(received.length, 0)
    assert.equal(h.Registry.Get('rc1')?.status, EnvStatus.Failed)
})

test('ReconcileStatus on an absent name resolves without a Put', async () =>
{
    const { h, received } = await ReconcileFixture.Seed(EnvStatus.Running)
    await h.Service.ReconcileStatus('ghost', true)
    assert.deepEqual(h.Calls.filter(c => c.startsWith('put:')), [])
    assert.equal(received.length, 0)
})

test('ReconcileStatus on Running with ready is idempotent: no Put', async () =>
{
    const { h, received } = await ReconcileFixture.Seed(EnvStatus.Running)
    await h.Service.ReconcileStatus('rc1', true)
    assert.deepEqual(h.Calls.filter(c => c.startsWith('put:')), [])
    assert.equal(received.length, 0)
})

test('ReconcileStatus on Unknown with ready Puts Running', async () =>
{
    const { h, received } = await ReconcileFixture.Seed(EnvStatus.Unknown)
    await h.Service.ReconcileStatus('rc1', true)
    assert.deepEqual(h.Calls.filter(c => c.startsWith('put:')), [`put:${EnvStatus.Running}`])
    assert.equal(received.length, 1)
    assert.equal(h.Registry.Get('rc1')?.status, EnvStatus.Running)
})

test('BOUND in-cluster Create federates with a split issuer/discovery and a byte-stable https browser redirect_uri', async () =>
{
    await IdpFixture.With('plat-t1', async (real, clients) =>
    {
        const h = await Harness.Make()
        const conn: IdpConnection = { ...real, browserBaseUrl: 'https://idp-plat-t1.hive.test', baseDomain: 'hive.test' }
        h.Service = new EnvironmentService(h.Registry, new FakeAllocator(h.Calls, false), SingleBackendResolver.Of(new DnsReachedFakeRuntime(h.Docker, h.Bundle), h.Directory, new HiveOrchestratorFactory()), h.Seeder, h.DataRoot, h.Proxy, h.Directory, new FakeIdp(conn), c => new IdpAdminClient(c))
        const rec = await h.Service.Create('fedic', Template.DevBlank, EnvType.Development, undefined, 'h1')
        const oidc = h.Bundle.Oidc
        assert.ok(oidc)
        assert.equal(oidc.issuer, 'https://idp-plat-t1.hive.test/plat-t1')
        assert.equal(oidc.discoveryUrl, conn.baseUrl + '/plat-t1/.well-known/openid-configuration')
        assert.equal(oidc.redirectUri, 'https://' + rec.environmentId + '.hive.test/auth/oidc/callback?environment=' + rec.environmentId)
        assert.equal(oidc.secretRef, rec.environmentId + '-oidc-secret')
        assert.equal(await clients.VerifySecret('plat-t1', oidc.clientId, oidc.secret), true)
        assert.equal(clients.RedirectAllowed('plat-t1', oidc.clientId, oidc.redirectUri), true)
        assert.equal(rec.idpBaseDomain, 'hive.test')
    })
})
