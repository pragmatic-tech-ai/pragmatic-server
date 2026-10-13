import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IHttpClient, IOidcFlowStateStore } from '@pragmatic-tech-ai/todl-identity-cloud'
import type { IdentityConfig } from '@pragmatic-tech-ai/todl-identity'
import { TenantRegistry, InMemoryTenantProvisioning } from '../tenant-registry.js'
import { InMemoryTenantCoordinator } from '../tenant-coordinator.js'
import type { IdentityRuntime } from '../../identity/identity-runtime.js'
import type { MachinePrincipalMap } from '../../host/machine-principal-map.js'
import type { TenantProvisioning } from '../tenant-provisioning.js'

class FakeRuntime implements IdentityRuntime
{
    public readonly HttpClient = { Sentinel: 'http' } as unknown as IHttpClient
    public readonly Sentinel = { Sentinel: 'flow' } as unknown as IOidcFlowStateStore
    public readonly Calls: string[] = []

    public FlowStateFor(tenantId: string): IOidcFlowStateStore
    {
        this.Calls.push(tenantId)
        return this.Sentinel
    }
}

class Fixtures
{
    public static readonly TenantId = 't1'
    public static readonly Config = { Marker: 'config' } as unknown as IdentityConfig
    public static readonly Machine = { Marker: 'machine' } as unknown as MachinePrincipalMap

    public static Provisioning(): TenantProvisioning
    {
        return { displayName: 'T1', identity: Fixtures.Config, machine: Fixtures.Machine } as unknown as TenantProvisioning
    }

    public static Registry(runtime?: IdentityRuntime): TenantRegistry
    {
        const provisioning = new InMemoryTenantProvisioning(new Map())
        return new TenantRegistry('/base', { base64Env: 'X' }, provisioning, new InMemoryTenantCoordinator(), undefined, undefined, undefined, undefined, runtime)
    }
}

test('OptionsFor forwards identity config, machine map and the shared runtime pieces', () =>
{
    const runtime = new FakeRuntime()
    const options = Fixtures.Registry(runtime).OptionsFor(Fixtures.TenantId, Fixtures.Provisioning())
    assert.equal(options.identity?.identityConfig, Fixtures.Config)
    assert.equal(options.identity?.machine, Fixtures.Machine)
    assert.equal(options.identity?.httpClient, runtime.HttpClient)
    assert.equal(options.identity?.flowStateStore, runtime.Sentinel)
    assert.deepEqual(runtime.Calls, [Fixtures.TenantId])
})

test('ServerFor rejects a tenant id containing a colon (flow-state key collision guard)', async () =>
{
    await assert.rejects(() => Fixtures.Registry().ServerFor('t1:x'), /invalid tenant id/)
})

test('OptionsFor without a runtime leaves the runtime pieces undefined', () =>
{
    const options = Fixtures.Registry().OptionsFor(Fixtures.TenantId, Fixtures.Provisioning())
    assert.equal(options.identity?.httpClient, undefined)
    assert.equal(options.identity?.flowStateStore, undefined)
})
