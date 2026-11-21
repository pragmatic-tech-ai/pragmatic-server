import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IHttpClient, IOidcFlowStateStore } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import type { IdentityConfig } from '@pragmatic-tech-ai/pragmatic-identity'
import { EnvironmentRegistry, InMemoryEnvironmentProvisioning } from '../environment-registry.js'
import { InMemoryEnvironmentCoordinator } from '../environment-coordinator.js'
import type { IdentityRuntime } from '../../identity/identity-runtime.js'
import type { MachinePrincipalMap } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import type { EnvironmentProvisioning } from '../environment-provisioning.js'

class FakeRuntime implements IdentityRuntime
{
    public readonly HttpClient = { Sentinel: 'http' } as unknown as IHttpClient
    public readonly Sentinel = { Sentinel: 'flow' } as unknown as IOidcFlowStateStore
    public readonly Calls: string[] = []

    public FlowStateFor(environmentId: string): IOidcFlowStateStore
    {
        this.Calls.push(environmentId)
        return this.Sentinel
    }
}

class Fixtures
{
    public static readonly EnvironmentId = 't1'
    public static readonly Config = { Marker: 'config' } as unknown as IdentityConfig
    public static readonly Machine = { Marker: 'machine' } as unknown as MachinePrincipalMap

    public static Provisioning(): EnvironmentProvisioning
    {
        return { displayName: 'T1', identity: Fixtures.Config, machine: Fixtures.Machine } as unknown as EnvironmentProvisioning
    }

    public static Registry(runtime?: IdentityRuntime): EnvironmentRegistry
    {
        const provisioning = new InMemoryEnvironmentProvisioning(new Map())
        return new EnvironmentRegistry('/base', { base64Env: 'X' }, provisioning, new InMemoryEnvironmentCoordinator(), undefined, undefined, undefined, undefined, runtime)
    }
}

test('OptionsFor forwards identity config, machine map and the shared runtime pieces', () =>
{
    const runtime = new FakeRuntime()
    const options = Fixtures.Registry(runtime).OptionsFor(Fixtures.EnvironmentId, Fixtures.Provisioning())
    assert.equal(options.identity?.identityConfig, Fixtures.Config)
    assert.equal(options.identity?.machine, Fixtures.Machine)
    assert.equal(options.identity?.httpClient, runtime.HttpClient)
    assert.equal(options.identity?.flowStateStore, runtime.Sentinel)
    assert.deepEqual(runtime.Calls, [Fixtures.EnvironmentId])
})

test('ServerFor rejects an environment id containing a colon (flow-state key collision guard)', async () =>
{
    await assert.rejects(() => Fixtures.Registry().ServerFor('t1:x'), /invalid environment id/)
})

test('OptionsFor without a runtime leaves the runtime pieces undefined', () =>
{
    const options = Fixtures.Registry().OptionsFor(Fixtures.EnvironmentId, Fixtures.Provisioning())
    assert.equal(options.identity?.httpClient, undefined)
    assert.equal(options.identity?.flowStateStore, undefined)
})
