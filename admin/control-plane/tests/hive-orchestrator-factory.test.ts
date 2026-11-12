import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAbsolute } from 'node:path'
import { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import { ForeignHiveError, UnsupportedBackendError } from '../hive-orchestrator.js'
import { KubectlHiveOrchestrator } from '../kubectl-hive-orchestrator.js'
import { KubectlCli } from '../kubectl.js'
import { KindClusterName } from '../kind-cluster-name.js'
import { KindHiveOrchestrator } from '../kind-hive-orchestrator.js'
import { KindHiveOrchestratorFactory } from '../kind-hive-orchestrator-factory.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import type { HiveRecord } from '../platform-records.js'
import { InClusterHiveOrchestrator } from '../in-cluster-hive-orchestrator.js'
import type { InClusterOrchestration } from '../in-cluster-hive-orchestrator.js'
import { EnvNamespaceGuard } from '../env-namespace-guard.js'
import { PinnedImageVerifier } from '../pinned-image-verifier.js'
import { KubeApiClient } from '../kube-api-client.js'

class FactoryFixture
{
    public static Hive(backend: HiveBackend, mode: InfraMode, configRef?: string): HiveRecord
    {
        return { id: 'hive-1', tenantId: 'acme-prod', displayName: 'Hive One', cluster: { backend, mode, configRef }, registry: { mode: InfraMode.Attach }, createdAt: '2026-10-22T00:00:00.000Z' }
    }

    public static HiveWithId(id: string): HiveRecord
    {
        return { ...FactoryFixture.Hive(HiveBackend.Local, InfraMode.Provision), id }
    }

    public static readonly Unsupported: ReadonlyArray<readonly [HiveBackend, InfraMode]> = [
        [HiveBackend.Aks, InfraMode.Provision],
        [HiveBackend.Aks, InfraMode.Attach],
        [HiveBackend.Eks, InfraMode.Provision],
        [HiveBackend.Eks, InfraMode.Attach],
        [HiveBackend.Gke, InfraMode.Provision],
        [HiveBackend.Gke, InfraMode.Attach],
        [HiveBackend.Private, InfraMode.Provision],
        [HiveBackend.Private, InfraMode.Attach],
    ]
}

test('local/attach yields a KubectlHiveOrchestrator', () =>
{
    const factory = new HiveOrchestratorFactory()
    assert.ok(factory.For(FactoryFixture.Hive(HiveBackend.Local, InfraMode.Attach)) instanceof KubectlHiveOrchestrator)
})

test('local/attach with a configRef still yields a KubectlHiveOrchestrator', () =>
{
    const factory = new HiveOrchestratorFactory('ignored-default')
    assert.ok(factory.For(FactoryFixture.Hive(HiveBackend.Local, InfraMode.Attach, 'kind-hive')) instanceof KubectlHiveOrchestrator)
})

test('configRef is used as the kubectl context', () =>
{
    const orchestrator = new HiveOrchestratorFactory().For(FactoryFixture.Hive(HiveBackend.Local, InfraMode.Attach, 'kind-hive')) as KubectlHiveOrchestrator
    assert.equal((orchestrator.Kubectl as KubectlCli).Context, 'kind-hive')
})

test('without a configRef the default docker-desktop context is used', () =>
{
    const orchestrator = new HiveOrchestratorFactory().For(FactoryFixture.Hive(HiveBackend.Local, InfraMode.Attach)) as KubectlHiveOrchestrator
    assert.equal((orchestrator.Kubectl as KubectlCli).Context, 'docker-desktop')
})

test('the wired registry rewrites images to the hive effective registry', () =>
{
    const hive = FactoryFixture.Hive(HiveBackend.Local, InfraMode.Attach)
    hive.registry = { mode: InfraMode.Provision }
    const orchestrator = new HiveOrchestratorFactory().For(hive) as KubectlHiveOrchestrator
    assert.equal(orchestrator.Registry.ImageRef('pragmatic-server:dev'), 'localhost:5000/pragmatic-server:dev')
})

for (const [backend, mode] of FactoryFixture.Unsupported)
{
    test(`${backend}/${mode} throws UnsupportedBackendError naming backend and mode`, () =>
    {
        const factory = new HiveOrchestratorFactory()
        assert.throws(
            () => factory.For(FactoryFixture.Hive(backend, mode)),
            (e: unknown) => e instanceof UnsupportedBackendError && e.message.includes(backend) && e.message.includes(mode))
    })
}

test('Local + Provision resolves to a KindHiveOrchestrator on the platform factory', () =>
{
    const factory = new KindHiveOrchestratorFactory()
    assert.ok(factory.For(FactoryFixture.Hive(HiveBackend.Local, InfraMode.Provision)) instanceof KindHiveOrchestrator)
})

test('the platform factory still drives an attached Local hive through kubectl', () =>
{
    const factory = new KindHiveOrchestratorFactory()
    assert.ok(factory.For(FactoryFixture.Hive(HiveBackend.Local, InfraMode.Attach)) instanceof KubectlHiveOrchestrator)
})

test('Local + Provision is unsupported without the kind driver (the in-hive tenant admin)', () =>
{
    const factory = new HiveOrchestratorFactory()
    assert.throws(
        () => factory.For(FactoryFixture.Hive(HiveBackend.Local, InfraMode.Provision)),
        (e: unknown) => e instanceof UnsupportedBackendError && e.message.includes(HiveBackend.Local) && e.message.includes(InfraMode.Provision))
})

test('two hives with different ids get different cluster names', () =>
{
    const factory = new KindHiveOrchestratorFactory()
    const a = factory.For(FactoryFixture.HiveWithId('hive-a')) as KindHiveOrchestrator
    const b = factory.For(FactoryFixture.HiveWithId('hive-b')) as KindHiveOrchestrator
    assert.notEqual(a.ClusterName, b.ClusterName)
    assert.equal(a.ClusterName, KindClusterName.For('hive-a'))
    assert.equal(b.ClusterName, KindClusterName.For('hive-b'))
})

test('the default data root is absolute (independent of cwd)', () =>
{
    const factory = new HiveOrchestratorFactory() as unknown as { dataRoot: string }
    assert.ok(isAbsolute(factory.dataRoot))
})

class InClusterFixture
{
    public static Setup(hiveId: string): InClusterOrchestration
    {
        return {
            client: new KubeApiClient({ Send: () => Promise.resolve({ status: 200, body: '{}' }) }),
            identity: { tenantId: 'acme-prod', hiveId },
            verifier: new PinnedImageVerifier([]),
        }
    }
}

test('in a pod a Local hive of this console gets the in-cluster orchestrator', () =>
{
    const factory = new HiveOrchestratorFactory(undefined, undefined, InClusterFixture.Setup('hive-1'))
    for (const mode of [InfraMode.Attach, InfraMode.Provision])
    {
        const orchestrator = factory.For(FactoryFixture.Hive(HiveBackend.Local, mode))
        assert.ok(orchestrator instanceof InClusterHiveOrchestrator)
        assert.ok(orchestrator.Kubectl instanceof EnvNamespaceGuard)
    }
})

test('another hive id throws UnsupportedBackendError', () =>
{
    const factory = new HiveOrchestratorFactory(undefined, undefined, InClusterFixture.Setup('hive-other'))
    assert.throws(() => factory.For(FactoryFixture.Hive(HiveBackend.Local, InfraMode.Attach)), UnsupportedBackendError)
    assert.throws(() => factory.For(FactoryFixture.Hive(HiveBackend.Local, InfraMode.Attach)), (e: unknown) =>
        e instanceof ForeignHiveError && e.HiveId === 'hive-1' && e.message === 'The tenant console manages only its own hive: hive-1')
    const inPod = new HiveOrchestratorFactory(undefined, undefined, InClusterFixture.Setup('hive-1'))
    assert.throws(() => inPod.For(FactoryFixture.Hive(HiveBackend.Aks, InfraMode.Attach)), UnsupportedBackendError)
})

test('without in-cluster setup the kubectl orchestrator is unchanged', () =>
{
    const factory = new HiveOrchestratorFactory(undefined, undefined, undefined)
    const orchestrator = factory.For(FactoryFixture.Hive(HiveBackend.Local, InfraMode.Attach))
    assert.ok(orchestrator instanceof KubectlHiveOrchestrator)
    assert.ok(orchestrator.Kubectl instanceof KubectlCli)
})
