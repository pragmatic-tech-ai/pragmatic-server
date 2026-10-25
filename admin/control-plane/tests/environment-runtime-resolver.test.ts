import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IEnvironmentRuntime } from '../environment-runtime.js'
import { EnvironmentRuntimeResolver } from '../environment-runtime-resolver.js'
import { EnvStatus, EnvType, Template, type EnvironmentRecord } from '../environment-record.js'

class Fx
{
    public static readonly Docker = { Id: 'docker' } as unknown as IEnvironmentRuntime
    public static readonly InCluster = { Id: 'incluster' } as unknown as IEnvironmentRuntime

    public static Record(hiveId?: string): EnvironmentRecord
    {
        return { name: 'e', type: EnvType.Development, template: Template.DevBlank, environmentId: 'e', hiveId, createdAt: 'now', status: EnvStatus.Running }
    }
}

test('unbound record resolves to the docker runtime', () =>
{
    const r = new EnvironmentRuntimeResolver(Fx.Docker, Fx.InCluster)
    assert.equal(r.For(Fx.Record()), Fx.Docker)
})

test('hive-bound record resolves to the in-cluster runtime', () =>
{
    const r = new EnvironmentRuntimeResolver(Fx.Docker, Fx.InCluster)
    assert.equal(r.For(Fx.Record('h1')), Fx.InCluster)
})
