import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KindHiveOrchestrator } from '../kind-hive-orchestrator.js'
import type { IKind } from '../kind.js'
import type { IHiveOrchestrator, WorkloadHealth } from '../hive-orchestrator.js'
import type { EnvironmentWorkload } from '../environment-workload.js'

class FakeKind implements IKind
{
    public clusters: string[] = []
    public created: string[] = []
    public deleted: string[] = []
    public loaded: { image: string; clusterName: string }[] = []

    public async CreateCluster(name: string): Promise<void>
    {
        this.created.push(name)
        this.clusters.push(name)
    }

    public async DeleteCluster(name: string): Promise<void>
    {
        this.deleted.push(name)
    }

    public async ListClusters(): Promise<readonly string[]>
    {
        return this.clusters
    }

    public async LoadImage(image: string, clusterName: string): Promise<void>
    {
        this.loaded.push({ image, clusterName })
    }
}

class FakeInner implements IHiveOrchestrator
{
    public calls: string[] = []
    public health: WorkloadHealth = { ready: true, runningImage: 'img:1', detail: 'ok' }

    public async Apply(_w: EnvironmentWorkload): Promise<void>
    {
        this.calls.push('Apply')
    }

    public async WaitHealthy(_w: EnvironmentWorkload): Promise<void>
    {
        this.calls.push('WaitHealthy')
    }

    public async Health(_w: EnvironmentWorkload): Promise<WorkloadHealth>
    {
        this.calls.push('Health')
        return this.health
    }

    public async Roll(_w: EnvironmentWorkload, _image: string): Promise<void>
    {
        this.calls.push('Roll')
    }

    public async Teardown(_w: EnvironmentWorkload): Promise<void>
    {
        this.calls.push('Teardown')
    }
}

class Fixture
{
    public static readonly Cluster = 'hive-a'
    public readonly kind = new FakeKind()
    public readonly inner = new FakeInner()
    public readonly sut = new KindHiveOrchestrator(this.kind, Fixture.Cluster, this.inner)
    public static readonly Workload: EnvironmentWorkload = {
        environmentName: 'dev',
        hiveId: 'h1',
        image: 'pragmatic-server:dev',
        serverPort: 8080,
        env: {},
        secretRefs: [],
    }
}

test('Apply creates the cluster when absent then delegates Apply', async () =>
{
    const f = new Fixture()
    await f.sut.Apply(Fixture.Workload)
    assert.ok(f.kind.created.includes(Fixture.Cluster))
    assert.ok(f.inner.calls.includes('Apply'))
})

test('Apply does not recreate when the cluster already exists', async () =>
{
    const f = new Fixture()
    f.kind.clusters = [Fixture.Cluster]
    await f.sut.Apply(Fixture.Workload)
    assert.deepEqual(f.kind.created, [])
    assert.ok(f.inner.calls.includes('Apply'))
})

test('Health returns not-ready without calling inner when the cluster is absent', async () =>
{
    const f = new Fixture()
    const h = await f.sut.Health(Fixture.Workload)
    assert.equal(h.ready, false)
    assert.equal(h.runningImage, undefined)
    assert.equal(h.detail, 'cluster not provisioned')
    assert.ok(!f.inner.calls.includes('Health'))
})

test('Health delegates to inner when the cluster exists', async () =>
{
    const f = new Fixture()
    f.kind.clusters = [Fixture.Cluster]
    const h = await f.sut.Health(Fixture.Workload)
    assert.ok(f.inner.calls.includes('Health'))
    assert.equal(h, f.inner.health)
})

test('Teardown delegates to inner and never deletes the cluster', async () =>
{
    const f = new Fixture()
    await f.sut.Teardown(Fixture.Workload)
    assert.ok(f.inner.calls.includes('Teardown'))
    assert.deepEqual(f.kind.deleted, [])
})

test('DestroyCluster deletes the cluster', async () =>
{
    const f = new Fixture()
    await f.sut.DestroyCluster()
    assert.ok(f.kind.deleted.includes(Fixture.Cluster))
})

test('Roll and WaitHealthy delegate to inner', async () =>
{
    const f = new Fixture()
    await f.sut.Roll(Fixture.Workload, 'img:2')
    await f.sut.WaitHealthy(Fixture.Workload)
    assert.ok(f.inner.calls.includes('Roll'))
    assert.ok(f.inner.calls.includes('WaitHealthy'))
})

test('ClusterName exposes the constructed name', () =>
{
    assert.equal(new Fixture().sut.ClusterName, Fixture.Cluster)
})

test('concurrent Apply on a fresh cluster creates it once', async () =>
{
    const f = new Fixture()
    await Promise.all([f.sut.Apply(Fixture.Workload), f.sut.Apply(Fixture.Workload)])
    assert.deepEqual(f.kind.created, [Fixture.Cluster])
})
