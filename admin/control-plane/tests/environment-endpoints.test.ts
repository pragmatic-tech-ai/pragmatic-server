import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { IKubectl, IPortForwardingKubectl, IProcessSpawner, ISpawnedProcess } from '../kubectl.js'
import { ClusterTunnelPool } from '../cluster-tunnel-pool.js'
import { EnvironmentEndpoints, EnvironmentUnreachableError } from '../environment-endpoints.js'
import { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import type { IHiveOrchestrator } from '../hive-orchestrator.js'
import { UnsupportedBackendError } from '../hive-orchestrator.js'
import { HiveBackend, InfraMode, type HiveRecord } from '../platform-records.js'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'
import { EnvStatus, EnvType, Template, type EnvironmentRecord } from '../environment-record.js'

class Fx
{
    public static readonly HiveId = 'h1'
    public static readonly EnvName = 'e1'
    public static readonly EnvId = 'e1'
    public static readonly Password = 'cluster-owner-pw'
    public static readonly LocalPassword = 'local-owner-pw'
    public static readonly LocalPort = 50123
    public static readonly HostPort = 9200
    public static readonly SecretsKey = 'provisioned-secrets.json'
    public static readonly AdminKey = 'e1-admin-pw'
    public static readonly Stamp = '2026-11-04T00:00:00.000Z'
    public static readonly Hive: HiveRecord = {
        id: Fx.HiveId, tenantId: 't1', displayName: 'H1', createdAt: Fx.Stamp,
        cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach, configRef: 'kube-ref' },
        registry: { mode: InfraMode.Attach, endpoint: 'reg.local', credentialRef: 'cred-ref' },
    }

    public static InCluster(): EnvironmentRecord
    {
        return { name: Fx.EnvName, environmentId: Fx.EnvId, template: Template.DevBlank, type: EnvType.Development, hiveId: Fx.HiveId, createdAt: Fx.Stamp, status: EnvStatus.Running }
    }

    public static Docker(bundleDir: string): EnvironmentRecord
    {
        return { ...Fx.InCluster(), hiveId: undefined, hostPort: Fx.HostPort, bundleDir }
    }

    public static SecretJson(secrets: Record<string, string>): string
    {
        const b64 = Buffer.from(JSON.stringify(secrets), 'utf8').toString('base64')
        return JSON.stringify({ apiVersion: 'v1', kind: 'Secret', data: { [Fx.SecretsKey]: b64 } })
    }
}

class FakeProcess implements ISpawnedProcess
{
    public readonly Stdout = new PassThrough()

    public Kill(): void
    {
    }

    public OnExit(): void
    {
    }
}

/** A kubectl with no port-forward capability (no context the platform can tunnel through). */
class PlainKubectl implements IKubectl
{
    public readonly Gets: string[] = []
    public readonly Forwards: string[] = []
    public SecretJson = Fx.SecretJson({ [Fx.AdminKey]: Fx.Password })

    public async Get(namespace: string, resource: string): Promise<string>
    {
        this.Gets.push(`${namespace} ${resource}`)
        return this.SecretJson
    }

    public async Apply(): Promise<void> { }
    public async RolloutStatus(): Promise<void> { }
    public async SetImage(): Promise<void> { }
    public async Scale(): Promise<void> { }
    public async ScaleStatefulSet(): Promise<void> { }
    public async RolloutRestart(): Promise<void> { }
    public async RolloutRestartSelector(): Promise<void> { }
    public async ApplyServerSide(): Promise<void> { }
    public async DeleteNamespace(): Promise<void> { }
    public async Find(): Promise<string | undefined> { return undefined }
    public async DeleteManifest(): Promise<void> { }
    public async DeleteBySelector(): Promise<void> { }
}

class FakeKubectl extends PlainKubectl implements IPortForwardingKubectl
{
    public async PortForward(namespace: string, target: string, remotePort: number): Promise<{ LocalPort: number; Process: ISpawnedProcess }>
    {
        this.Forwards.push(`${namespace} ${target} ${remotePort}`)
        return { LocalPort: Fx.LocalPort, Process: new FakeProcess() }
    }
}

class FakeOrchestrators extends HiveOrchestratorFactory
{
    public Fail: Error | undefined

    public constructor(private readonly kubectl: IKubectl)
    {
        super()
    }

    public override For(): IHiveOrchestrator
    {
        if (this.Fail !== undefined)
        {
            throw this.Fail
        }
        return { Kubectl: this.kubectl } as unknown as IHiveOrchestrator
    }
}

class FakeDirectory implements ITenantDirectory
{
    public GetTenant(): undefined
    {
        return undefined
    }

    public GetHive(id: string): HiveRecord | undefined
    {
        return id === Fx.HiveId ? Fx.Hive : undefined
    }

    public ListHives(): readonly HiveRecord[]
    {
        return [Fx.Hive]
    }
}

class NoSpawner implements IProcessSpawner
{
    public Spawn(): ISpawnedProcess
    {
        throw new Error('the fake kubectl forwards without spawning')
    }
}

class Harness
{
    public readonly Kubectl: PlainKubectl
    public readonly Orchestrators: FakeOrchestrators
    public readonly Pool = new ClusterTunnelPool(new NoSpawner())
    public readonly Endpoints: EnvironmentEndpoints

    public constructor(kubectl: PlainKubectl = new FakeKubectl())
    {
        this.Kubectl = kubectl
        this.Orchestrators = new FakeOrchestrators(kubectl)
        this.Endpoints = new EnvironmentEndpoints(this.Orchestrators, new FakeDirectory(), this.Pool)
    }
}

test('Docker UrlsFor keeps localhost:<hostPort>', async () =>
{
    const h = new Harness()
    assert.deepEqual(await h.Endpoints.UrlsFor(Fx.Docker('/b/e1')), { httpUrl: 'http://localhost:9200', wsUrl: 'ws://localhost:9200' })
    assert.equal(h.Kubectl.Forwards.length, 0)
})

test('in-cluster UrlsFor tunnels to the server Service and returns 127.0.0.1:<local>', async () =>
{
    const h = new Harness()
    assert.deepEqual(await h.Endpoints.UrlsFor(Fx.InCluster()), { httpUrl: 'http://127.0.0.1:50123', wsUrl: 'ws://127.0.0.1:50123' })
    assert.deepEqual(h.Kubectl.Forwards, ['pragmatic-env-e1 svc/pragmatic-env-e1-server 8080'])
    await h.Endpoints.UrlsFor(Fx.InCluster())
    assert.equal(h.Kubectl.Forwards.length, 1)
    h.Pool.CloseAll()
})

test('in-cluster UrlsFor on a hive with no kubectl context throws EnvironmentUnreachableError', async () =>
{
    const h = new Harness(new PlainKubectl())
    await assert.rejects(() => h.Endpoints.UrlsFor(Fx.InCluster()), (err: Error) =>
        err instanceof EnvironmentUnreachableError && err.message === 'The environment\'s hive is not reachable from the platform.')
})

test('in-cluster UrlsFor on an unsupported hive backend throws EnvironmentUnreachableError', async () =>
{
    const h = new Harness()
    h.Orchestrators.Fail = new UnsupportedBackendError(HiveBackend.Local, InfraMode.Attach)
    await assert.rejects(() => h.Endpoints.UrlsFor(Fx.InCluster()), EnvironmentUnreachableError)
})

test('in-cluster UrlsFor on a record whose hive is unknown throws EnvironmentUnreachableError', async () =>
{
    const h = new Harness()
    await assert.rejects(() => h.Endpoints.UrlsFor({ ...Fx.InCluster(), hiveId: 'gone' }), EnvironmentUnreachableError)
})

test('in-cluster AdminPasswordFor decodes the provisioned-secrets entry of the env Secret', async () =>
{
    const h = new Harness()
    assert.equal(await h.Endpoints.AdminPasswordFor(Fx.InCluster(), '/unused'), Fx.Password)
    assert.deepEqual(h.Kubectl.Gets, ['pragmatic-env-e1 secret/e1-env-secrets'])
})

test('in-cluster AdminPasswordFor without the admin entry throws without naming any secret value', async () =>
{
    const h = new Harness()
    h.Kubectl.SecretJson = Fx.SecretJson({ other: Fx.Password })
    await assert.rejects(() => h.Endpoints.AdminPasswordFor(Fx.InCluster(), '/unused'), (err: Error) =>
        /no provisioned secret for e1-admin-pw/.test(err.message) && !err.message.includes(Fx.Password))
})

test('Docker AdminPasswordFor reads the local bundle', async () =>
{
    const h = new Harness()
    const bundleDir = await mkdtemp(join(tmpdir(), 'endpoints-bundle-'))
    await writeFile(join(bundleDir, Fx.SecretsKey), JSON.stringify({ [Fx.AdminKey]: Fx.LocalPassword }))
    assert.equal(await h.Endpoints.AdminPasswordFor(Fx.Docker(bundleDir), '/unused'), Fx.LocalPassword)
    assert.equal(h.Kubectl.Gets.length, 0)
})
