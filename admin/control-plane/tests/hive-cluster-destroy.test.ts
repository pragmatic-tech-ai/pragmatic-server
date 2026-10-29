import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PlatformDeploymentRegistry } from '../platform-deployment-registry.js'
import { KindHiveOrchestrator } from '../kind-hive-orchestrator.js'
import { UnsupportedBackendError } from '../hive-orchestrator.js'
import type { IHiveOrchestrator } from '../hive-orchestrator.js'
import type { IKind, KindClusterConfig } from '../kind.js'
import type { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import type { HiveRecord } from '../platform-records.js'

class FakeKind implements IKind
{
    public deleted: string[] = []
    public FailWith: Error | undefined

    public async CreateCluster(_name: string, _config?: KindClusterConfig): Promise<void>
    {
    }

    public async DeleteCluster(name: string): Promise<void>
    {
        if (this.FailWith)
        {
            throw this.FailWith
        }
        this.deleted.push(name)
    }

    public async ListClusters(): Promise<readonly string[]>
    {
        return []
    }

    public async LoadImage(_image: string, _clusterName: string): Promise<void>
    {
    }
}

class Fx
{
    public static readonly HiveId = 'h1'
    public static readonly Cluster = 'hive-h1'

    public static Hive(mode: InfraMode): HiveRecord
    {
        return { id: Fx.HiveId, tenantId: 't1', displayName: 'H', cluster: { backend: HiveBackend.Local, mode }, registry: { mode }, createdAt: '2026-10-30T00:00:00.000Z' } as HiveRecord
    }

    public static Registry(hive: HiveRecord | undefined, orchestrator: () => IHiveOrchestrator): PlatformDeploymentRegistry
    {
        const factory = { For: () => orchestrator() } as unknown as HiveOrchestratorFactory
        return new PlatformDeploymentRegistry(
            undefined as never, undefined as never, undefined as never, undefined as never,
            { GetHive: () => hive }, factory, { List: () => [] }, undefined as never, undefined as never)
    }

    public static Kind(kind: FakeKind): IHiveOrchestrator
    {
        return new KindHiveOrchestrator(kind, Fx.Cluster, undefined as unknown as IHiveOrchestrator)
    }
}

test('DestroyHiveCluster destroys the cluster of a Provision-mode kind hive', async () =>
{
    const kind = new FakeKind()
    await Fx.Registry(Fx.Hive(InfraMode.Provision), () => Fx.Kind(kind)).DestroyHiveCluster(Fx.HiveId)
    assert.deepEqual(kind.deleted, [Fx.Cluster])
})

test('DestroyHiveCluster surfaces a destroy failure', async () =>
{
    const kind = new FakeKind()
    kind.FailWith = new Error('kind down')
    await assert.rejects(() => Fx.Registry(Fx.Hive(InfraMode.Provision), () => Fx.Kind(kind)).DestroyHiveCluster(Fx.HiveId), /kind down/)
})

test('DestroyHiveCluster never destroys an Attach-mode hive', async () =>
{
    const kind = new FakeKind()
    await Fx.Registry(Fx.Hive(InfraMode.Attach), () => Fx.Kind(kind)).DestroyHiveCluster(Fx.HiveId)
    assert.deepEqual(kind.deleted, [])
})

test('DestroyHiveCluster is a no-op for an unknown hive or an unsupported backend', async () =>
{
    const kind = new FakeKind()
    await Fx.Registry(undefined, () => Fx.Kind(kind)).DestroyHiveCluster(Fx.HiveId)
    await Fx.Registry(Fx.Hive(InfraMode.Provision), () => { throw new UnsupportedBackendError(HiveBackend.Aks, InfraMode.Provision) }).DestroyHiveCluster(Fx.HiveId)
    assert.deepEqual(kind.deleted, [])
})
