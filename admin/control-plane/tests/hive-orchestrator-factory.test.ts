import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import { UnsupportedBackendError } from '../hive-orchestrator.js'
import { KubectlHiveOrchestrator } from '../kubectl-hive-orchestrator.js'
import { KubectlCli } from '../kubectl.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import type { HiveRecord } from '../platform-records.js'

class FactoryFixture
{
    public static Hive(backend: HiveBackend, mode: InfraMode, configRef?: string): HiveRecord
    {
        return { id: 'hive-1', tenantId: 'acme-prod', displayName: 'Hive One', cluster: { backend, mode, configRef }, registry: { mode: InfraMode.Attach }, createdAt: '2026-10-22T00:00:00.000Z' }
    }

    public static readonly Unsupported: ReadonlyArray<readonly [HiveBackend, InfraMode]> = [
        [HiveBackend.Aks, InfraMode.Attach],
        [HiveBackend.Local, InfraMode.Provision],
        [HiveBackend.Private, InfraMode.Attach],
        [HiveBackend.Eks, InfraMode.Provision],
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
