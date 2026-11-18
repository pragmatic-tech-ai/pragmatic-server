import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sep } from 'node:path'
import { InMemoryEnvironmentCoordinator } from '../environment-coordinator.js'
import { InMemoryEnvironmentProvisioning, EnvironmentRegistry } from '../environment-registry.js'
import { EnvironmentPurpose } from '../environment-purpose.js'
import { PragmaticServer } from '../../pragmatic-server.js'

class PurposeFixture
{
    public static readonly KeyEnv = 'PS_C1_KEY'
    public static readonly BaseDir = 'base'
    public static readonly EnvironmentId = 't1'
    public static readonly Display = 'T'

    public static Registry(): EnvironmentRegistry
    {
        return new EnvironmentRegistry(PurposeFixture.BaseDir, { base64Env: PurposeFixture.KeyEnv }, new InMemoryEnvironmentProvisioning(new Map()), new InMemoryEnvironmentCoordinator())
    }
}

test('OptionsFor threads Runtime purpose and the per-environment applications root', () =>
{
    const options = PurposeFixture.Registry().OptionsFor(PurposeFixture.EnvironmentId, { displayName: PurposeFixture.Display, purpose: EnvironmentPurpose.Runtime })
    assert.equal(options.purpose, EnvironmentPurpose.Runtime)
    assert.ok(options.applicationsRoot!.endsWith(`${PurposeFixture.EnvironmentId}${sep}applications`))
})

test('absent purpose defaults to Development', () =>
{
    const options = PurposeFixture.Registry().OptionsFor(PurposeFixture.EnvironmentId, { displayName: PurposeFixture.Display })
    assert.equal(new PragmaticServer(options).Purpose(), EnvironmentPurpose.Development)
})

test('a bare PragmaticServer is Development', () =>
{
    assert.equal(new PragmaticServer({}).Purpose(), EnvironmentPurpose.Development)
})

test('ServesDevelopment / ServesRuntime across the provisioning shapes', () =>
{
    const registry = PurposeFixture.Registry()
    const build = (provisioning: { purpose?: EnvironmentPurpose, runtimeCoHosted?: boolean }) => new PragmaticServer(registry.OptionsFor(PurposeFixture.EnvironmentId, { displayName: PurposeFixture.Display, ...provisioning }))
    const dual = build({ purpose: EnvironmentPurpose.Development, runtimeCoHosted: true })
    assert.equal(dual.ServesDevelopment(), true)
    assert.equal(dual.ServesRuntime(), true)
    assert.equal(dual.Purpose(), EnvironmentPurpose.Development)
    const dev = build({ purpose: EnvironmentPurpose.Development })
    assert.equal(dev.ServesDevelopment(), true)
    assert.equal(dev.ServesRuntime(), false)
    const runtime = build({ purpose: EnvironmentPurpose.Runtime })
    assert.equal(runtime.ServesRuntime(), true)
    assert.equal(runtime.ServesDevelopment(), false)
})

test('a dual-purpose server constructs both the dev and the runtime getters', () =>
{
    const options = PurposeFixture.Registry().OptionsFor(PurposeFixture.EnvironmentId, { displayName: PurposeFixture.Display, purpose: EnvironmentPurpose.Development, runtimeCoHosted: true })
    const server = new PragmaticServer(options)
    assert.ok(server.GraphService())
    assert.ok(server.EnvironmentEngine())
    assert.ok(server.Applications())
})

test('a plain Development server still refuses the runtime getters', () =>
{
    const server = new PragmaticServer(PurposeFixture.Registry().OptionsFor(PurposeFixture.EnvironmentId, { displayName: PurposeFixture.Display }))
    assert.throws(() => server.Applications())
})
