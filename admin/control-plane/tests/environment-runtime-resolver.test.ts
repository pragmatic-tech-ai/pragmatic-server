import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IEnvironmentRuntime } from '../environment-runtime.js'
import { EnvironmentRuntimeResolver } from '../environment-runtime-resolver.js'
import { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import { UnsupportedBackendError } from '../hive-orchestrator.js'
import { HiveBackend, InfraMode, type HiveRecord, type TenantRecord } from '../platform-records.js'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'
import { EnvStatus, EnvType, Template, type EnvironmentRecord } from '../environment-record.js'

class Fx
{
    public static readonly Docker = { Id: 'docker' } as unknown as IEnvironmentRuntime
    public static readonly InCluster = { Id: 'incluster' } as unknown as IEnvironmentRuntime
    private static readonly HiveId = 'h1'

    public static Record(hiveId?: string): EnvironmentRecord
    {
        return { name: 'e', type: EnvType.Development, template: Template.DevBlank, environmentId: 'e', hiveId, createdAt: 'now', status: EnvStatus.Running }
    }

    public static Hive(backend: HiveBackend, mode: InfraMode): HiveRecord
    {
        return { id: Fx.HiveId, tenantId: 't1', displayName: 'H1', cluster: { backend, mode, configRef: 'ctx' }, registry: { mode }, createdAt: 'now' }
    }

    public static Directory(hive: HiveRecord | undefined): ITenantDirectory
    {
        return {
            GetTenant: (): TenantRecord | undefined => undefined,
            GetHive: (id: string): HiveRecord | undefined => hive !== undefined && id === hive.id ? hive : undefined,
            ListHives: (): readonly HiveRecord[] => hive === undefined ? [] : [hive]
        }
    }

    public static Resolver(hive: HiveRecord | undefined): EnvironmentRuntimeResolver
    {
        return new EnvironmentRuntimeResolver(Fx.Docker, Fx.InCluster, Fx.Directory(hive), new HiveOrchestratorFactory())
    }
}

test('unbound record resolves to the docker runtime', () =>
{
    const r = Fx.Resolver(undefined)
    assert.equal(r.For(Fx.Record()), Fx.Docker)
})

test('hive-bound record on a supported k8s backend resolves to the in-cluster runtime', () =>
{
    const r = Fx.Resolver(Fx.Hive(HiveBackend.Local, InfraMode.Attach))
    assert.equal(r.For(Fx.Record('h1')), Fx.InCluster)
})

test('hive-bound record on an unsupported (cloud) backend throws UnsupportedBackendError eagerly', () =>
{
    const r = Fx.Resolver(Fx.Hive(HiveBackend.Aks, InfraMode.Provision))
    assert.throws(() => r.For(Fx.Record('h1')), UnsupportedBackendError)
})
