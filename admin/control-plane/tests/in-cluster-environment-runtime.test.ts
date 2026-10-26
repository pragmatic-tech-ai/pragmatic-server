import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BundleBuilderAdapter } from '../docker-env-port.js'
import { EnvServerSeedSource } from '../env-server-seed.js'
import type { IKubectl } from '../kubectl.js'
import assert from 'node:assert/strict'
import type { EnvDefinition } from '../../../environments/seed/bundle.js'
import type { EnvRuntimeContext } from '../environment-runtime.js'
import type { EnvironmentPlacement } from '../environment-placement.js'
import type { EnvironmentWorkload } from '../environment-workload.js'
import type { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import type { IHiveOrchestrator, WorkloadHealth } from '../hive-orchestrator.js'
import type { HiveRecord } from '../platform-records.js'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import { EnvStatus, EnvType, Template, type EnvironmentRecord } from '../environment-record.js'
import { EnvLogsUnavailableInClusterError, InClusterEnvironmentRuntime, InClusterHiveMissingError, InClusterOperationFailedError, InClusterBundleMissingError } from '../in-cluster-environment-runtime.js'

class Fx
{
    public static readonly Secret = 'kubectl stderr SECRET-VALUE'
    public static readonly Workload = { environmentName: 'e1', hiveId: 'h1', serverPort: 8080 } as unknown as EnvironmentWorkload
    public static readonly Hive = { id: 'h1' } as unknown as HiveRecord
    public static readonly Def = { name: 'e1', environmentId: 'env-1' } as unknown as EnvDefinition
}

class FakeKubectl
{
    public readonly Applied: string[] = []
    public Log: string[] | undefined
    public FailWith: Error | undefined

    public async Apply(manifestJson: string): Promise<void>
    {
        this.Log?.push('KubectlApply')
        if (this.FailWith)
        {
            throw this.FailWith
        }
        this.Applied.push(manifestJson)
    }
}

class FakeOrchestrator implements IHiveOrchestrator
{
    public readonly Calls: { m: string; w: EnvironmentWorkload }[] = []
    public readonly Order: string[] = []
    public readonly Fake = new FakeKubectl()
    public readonly Kubectl = this.Fake as unknown as IKubectl

    public constructor()
    {
        this.Fake.Log = this.Order
    }

    public FailWith: Error | undefined
    public Ready = true
    public readonly ScaleReplicas: number[] = []

    private Rec(m: string, w: EnvironmentWorkload): void
    {
        this.Calls.push({ m, w })
        this.Order.push(m)
        if (this.FailWith)
        {
            throw this.FailWith
        }
    }

    public async Apply(w: EnvironmentWorkload): Promise<void> { this.Rec('Apply', w) }
    public async WaitHealthy(w: EnvironmentWorkload): Promise<void> { this.Rec('WaitHealthy', w) }
    public async Health(w: EnvironmentWorkload): Promise<WorkloadHealth> { this.Rec('Health', w); return { ready: this.Ready, runningImage: undefined, detail: '' } }
    public async Roll(w: EnvironmentWorkload, _image: string): Promise<void> { this.Rec('Roll', w) }
    public async Scale(w: EnvironmentWorkload, replicas: number): Promise<void> { this.Rec('Scale', w); this.ScaleReplicas.push(replicas) }
    public async Teardown(w: EnvironmentWorkload): Promise<void> { this.Rec('Teardown', w) }
}

class Harness
{
    public readonly Orchestrator = new FakeOrchestrator()
    public readonly Runtime: InClusterEnvironmentRuntime
    public readonly Record: EnvironmentRecord = { name: 'e1', type: EnvType.Runtime, template: Template.DevBlank, environmentId: 'env-1', hiveId: 'h1', createdAt: 'now', status: EnvStatus.Running }
    public readonly BundleDir = mkdtempSync(join(tmpdir(), 'icr-'))
    public readonly Ctx: EnvRuntimeContext = { def: Fx.Def, record: this.Record, bundleDir: this.BundleDir }

    public constructor(hiveKnown: boolean = true, workload: EnvironmentWorkload = Fx.Workload)
    {
        const orchestrator = this.Orchestrator
        const factory = { For: (_h: HiveRecord) => orchestrator } as unknown as HiveOrchestratorFactory
        const placement = { WorkloadFor: (_r: EnvironmentRecord) => workload } as unknown as EnvironmentPlacement
        const directory: ITenantDirectory = {
            GetTenant: () => undefined,
            GetHive: () => hiveKnown ? Fx.Hive : undefined,
            ListHives: () => []
        }
        this.Runtime = new InClusterEnvironmentRuntime(factory, placement, directory, new BundleBuilderAdapter())
    }
}

test('BringUp applies the placement workload and returns a DNS endpoint with no hostPort', async () =>
{
    const h = new Harness()
    await h.Runtime.Prepare(h.Ctx)
    const ep = await h.Runtime.BringUp(h.Ctx)
    assert.deepEqual(h.Orchestrator.Calls, [{ m: 'Apply', w: Fx.Workload }])
    assert.equal(ep.hostPort, undefined)
    const host = `${K8sManifestBuilder.ServerDeploymentOf('e1')}.${K8sManifestBuilder.NamespaceOf('e1')}.svc.cluster.local:8080`
    assert.equal(ep.httpUrl, `http://${host}`)
    assert.equal(ep.wsUrl, `ws://${host}/?environment=env-1`)
})

test('Start applies then waits healthy', async () =>
{
    const h = new Harness()
    await h.Runtime.Prepare(h.Ctx)
    await h.Runtime.Start(h.Ctx)
    assert.deepEqual(h.Orchestrator.Calls.map(c => c.m), ['Apply', 'WaitHealthy'])
})

test('BringUp without a bundle dir throws the named missing-bundle error before touching the cluster', async () =>
{
    const h = new Harness()
    const ctx: EnvRuntimeContext = { def: Fx.Def, record: h.Record, bundleDir: undefined }
    await assert.rejects(() => h.Runtime.BringUp(ctx), InClusterBundleMissingError)
    assert.equal(h.Orchestrator.Calls.length, 0)
})

test('Teardown calls orchestrator Teardown; RemoveVolume is a no-op', async () =>
{
    const h = new Harness()
    await h.Runtime.Teardown(h.Ctx, true)
    await h.Runtime.RemoveVolume(h.Ctx)
    assert.deepEqual(h.Orchestrator.Calls, [{ m: 'Teardown', w: Fx.Workload }])
})

test('a thrown Apply surfaces the fixed generic error without stderr text', async () =>
{
    const h = new Harness()
    h.Orchestrator.FailWith = new Error(Fx.Secret)
    await assert.rejects(() => h.Runtime.BringUp(h.Ctx), (e: Error) => e instanceof InClusterOperationFailedError && !e.message.includes('SECRET'))
})

test('WaitHealthy and Teardown failures are also mapped to the generic error', async () =>
{
    const h = new Harness()
    h.Orchestrator.FailWith = new Error(Fx.Secret)
    await assert.rejects(() => h.Runtime.WaitHealthy(h.Ctx), InClusterOperationFailedError)
    await assert.rejects(() => h.Runtime.Teardown(h.Ctx, true), InClusterOperationFailedError)
})

test('Logs and LogStream throw the named unavailable error', async () =>
{
    const h = new Harness()
    await assert.rejects(() => h.Runtime.Logs(h.Ctx), EnvLogsUnavailableInClusterError)
    assert.throws(() => h.Runtime.LogStream(h.Ctx, () => {}), EnvLogsUnavailableInClusterError)
})

test('Stop scales the server to 0 and never tears down', async () =>
{
    const h = new Harness()
    await h.Runtime.Stop(h.Ctx)
    assert.deepEqual(h.Orchestrator.ScaleReplicas, [0])
    assert.ok(h.Orchestrator.Calls.some(c => c.m === 'Scale'))
    assert.ok(!h.Orchestrator.Calls.some(c => c.m === 'Teardown'))
    assert.ok(!h.Orchestrator.Order.includes('Teardown'))
})

test('A failing Scale on Stop maps to the generic error without stderr text', async () =>
{
    const h = new Harness()
    h.Orchestrator.FailWith = new Error(Fx.Secret)
    await assert.rejects(() => h.Runtime.Stop(h.Ctx), (e: Error) => e instanceof InClusterOperationFailedError && !e.message.includes('SECRET'))
})

test('Probe returns Health().ready', async () =>
{
    const h = new Harness()
    assert.equal(await h.Runtime.Probe(h.Ctx), true)
    h.Orchestrator.Ready = false
    assert.equal(await h.Runtime.Probe(h.Ctx), false)
})

test('EnsureImage is true and Prepare never touches the orchestrator', async () =>
{
    const h = new Harness()
    assert.equal(await h.Runtime.EnsureImage(Fx.Def), true)
    await h.Runtime.Prepare(h.Ctx)
    assert.equal(h.Orchestrator.Calls.length, 0)
})

test('Prepare generates the bundle and a second Prepare keeps master.key byte-identical', async () =>
{
    const h = new Harness()
    await h.Runtime.Prepare(h.Ctx)
    for (const f of ['master.key', 'provisioned-secrets.json', 'tenants.json'])
    {
        assert.ok(existsSync(join(h.BundleDir, f)), f)
    }
    const first = readFileSync(join(h.BundleDir, 'master.key'))
    await h.Runtime.Prepare(h.Ctx)
    assert.ok(first.equals(readFileSync(join(h.BundleDir, 'master.key'))))
})

test('BringUp applies the workload first, then a seed List with the ConfigMap and Secret the Deployment references', async () =>
{
    const h = new Harness()
    await h.Runtime.Prepare(h.Ctx)
    await h.Runtime.BringUp(h.Ctx)
    assert.deepEqual(h.Orchestrator.Order, ['Apply', 'KubectlApply'])
    assert.equal(h.Orchestrator.Fake.Applied.length, 1)
    const items = (JSON.parse(h.Orchestrator.Fake.Applied[0]) as { items: { kind: string; metadata: { name: string } }[] }).items
    assert.ok(items.some(i => i.kind === 'ConfigMap' && i.metadata.name === EnvServerSeedSource.ConfigMapNameOf('e1')))
    assert.ok(items.some(i => i.kind === 'Secret' && i.metadata.name === EnvServerSeedSource.SecretNameOf('e1')))
})

test('BringUp applies the ca.crt-only IdP trust Secret when the workload is federated and caPem is present', async () =>
{
    const workload = { ...Fx.Workload, federation: { baseDomain: 'hive.test', caSecretName: EnvServerSeedSource.IdpCaSecretNameOf('e1') } } as EnvironmentWorkload
    const h = new Harness(true, workload)
    await h.Runtime.Prepare(h.Ctx)
    const ctx: EnvRuntimeContext = { ...h.Ctx, caPem: Buffer.from('CA-PEM-BYTES') }
    await h.Runtime.BringUp(ctx)
    const idpCa = h.Orchestrator.Fake.Applied.map(a => JSON.parse(a) as { kind?: string; metadata?: { name?: string } }).find(m => m.kind === 'Secret' && m.metadata?.name === EnvServerSeedSource.IdpCaSecretNameOf('e1'))
    assert.ok(idpCa, 'the <env>-idp-ca Secret is applied so the pod CA mount resolves')
})

test('a failing seed apply surfaces the generic error with no secret bytes or stderr', async () =>
{
    const h = new Harness()
    await h.Runtime.Prepare(h.Ctx)
    h.Orchestrator.Fake.FailWith = new Error(Fx.Secret)
    await assert.rejects(() => h.Runtime.BringUp(h.Ctx), (e: Error) => e instanceof InClusterOperationFailedError && !e.message.includes('SECRET') && !e.message.includes('stderr'))
})

test('a missing hive throws the fixed hive-missing error', async () =>
{
    const h = new Harness(false)
    await assert.rejects(() => h.Runtime.BringUp(h.Ctx), InClusterHiveMissingError)
})

test('BringUp threads def.environmentId (not record.name) into the seed Secret, after the workload Apply', async () =>
{
    const h = new Harness()
    const seededId = 'env-seeded-42'
    const ctx: EnvRuntimeContext = { def: { name: 'e1', environmentId: seededId } as unknown as EnvDefinition, record: h.Record, bundleDir: h.BundleDir }
    await h.Runtime.Prepare(ctx)
    const treeDir = join(h.BundleDir, 'data', seededId, 'contoso')
    mkdirSync(treeDir, { recursive: true })
    writeFileSync(join(treeDir, 'marker.txt'), 'seed-bytes')
    await h.Runtime.BringUp(ctx)
    assert.deepEqual(h.Orchestrator.Order, ['Apply', 'KubectlApply'])
    const items = (JSON.parse(h.Orchestrator.Fake.Applied[0]) as { items: { kind: string; metadata: { name: string }; data: Record<string, string> }[] }).items
    const seed = items.find(i => i.kind === 'Secret' && i.metadata.name === EnvServerSeedSource.SeedSecretNameOf('e1'))
    assert.ok(seed, 'seed Secret named from the environment name')
    const tree = JSON.parse(Buffer.from(seed.data[EnvServerSeedSource.SeedKey], 'base64').toString('utf8')) as Record<string, string>
    assert.ok(Object.keys(tree).includes('contoso/marker.txt'))
    assert.equal(Buffer.from(tree['contoso/marker.txt'], 'base64').toString('utf8'), 'seed-bytes')
})

test('BringUp never projects data/<record.name> when it differs from def.environmentId', async () =>
{
    const h = new Harness()
    mkdirSync(join(h.BundleDir, 'data', 'e1'), { recursive: true })
    writeFileSync(join(h.BundleDir, 'data', 'e1', 'wrong.txt'), 'x')
    await h.Runtime.Prepare(h.Ctx)
    await h.Runtime.BringUp(h.Ctx)
    const items = (JSON.parse(h.Orchestrator.Fake.Applied[0]) as { items: { kind: string; metadata: { name: string }; data: Record<string, string> }[] }).items
    for (const seed of items.filter(i => i.metadata.name === EnvServerSeedSource.SeedSecretNameOf('e1')))
    {
        const tree = JSON.parse(Buffer.from(seed.data[EnvServerSeedSource.SeedKey], 'base64').toString('utf8')) as Record<string, string>
        assert.ok(!Object.keys(tree).includes('wrong.txt'))
    }
})
