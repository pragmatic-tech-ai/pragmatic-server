import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DeploymentMode, type ServerConfig } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import { ServerBootstrap } from '../server-bootstrap.js'
import { ProvisionedSecretSource } from '../../config/provisioned-secret-source.js'
import { InMemoryEnvironmentProvisioning } from '../../environments/environment-registry.js'
import type { EnvironmentProvisioning } from '../../environments/environment-provisioning.js'

class Fixture
{
    public static Config(mode: DeploymentMode): ServerConfig
    {
        return { host: '0.0.0.0', port: 8080, baseDir: '/data', masterKey: { keyFilePath: '/run/secrets/key' }, deploymentMode: mode, singleEnvironment: { id: 't1', displayName: 'Environment One' }, idleTtlMs: 1000 }
    }

    public static Provisioning(): InMemoryEnvironmentProvisioning
    {
        const entries = new Map<string, EnvironmentProvisioning>()
        entries.set('t1', { displayName: 'Environment One' })
        return new InMemoryEnvironmentProvisioning(entries)
    }
}

test('composes host options from a local config', () =>
{
    const options = ServerBootstrap.ComposeOptions(Fixture.Config(DeploymentMode.Local), Fixture.Provisioning())
    assert.equal(options.port, 8080)
    assert.equal(options.host, '0.0.0.0')
    assert.equal(options.baseDir, '/data')
    assert.deepEqual(options.masterKey, { keyFilePath: '/run/secrets/key' })
    assert.equal(options.deploymentMode, DeploymentMode.Local)
    assert.equal(options.platform, undefined)
    assert.equal(options.idleTtlMs, 1000)
})

test('cloud mode without an injected platform fails closed', () =>
{
    assert.throws(() => ServerBootstrap.ComposeOptions(Fixture.Config(DeploymentMode.Cloud), Fixture.Provisioning()), /cloud/i)
})

test('the startup line never contains the master key reference target', () =>
{
    const line = ServerBootstrap.StartupLine(Fixture.Config(DeploymentMode.Local), 1)
    assert.ok(!line.includes('/run/secrets/key'))
    assert.ok(line.includes('8080'))
    assert.ok(line.includes('environments=1'))
})

test('ComposeOptions carries the provisioned secret source onto the host options', () =>
{
    const source = ProvisionedSecretSource.FromText('{}')
    const options = ServerBootstrap.ComposeOptions(Fixture.Config(DeploymentMode.Local), Fixture.Provisioning(), undefined, source)
    assert.equal(options.provisionedSecrets, source)
})

test('StartupLine reports secrets=file when a provisioned-secrets file is configured', () =>
{
    const config = { ...Fixture.Config(DeploymentMode.Local), provisionedSecretsFile: '/run/secrets/provisioned/secrets.json' }
    const line = ServerBootstrap.StartupLine(config, 1)
    assert.match(line, / secrets=file/)
    assert.ok(!line.includes('/run/secrets/provisioned/secrets.json'))
})

test('StartupLine reports secrets=none when no provisioned-secrets file is configured', () =>
{
    assert.match(ServerBootstrap.StartupLine(Fixture.Config(DeploymentMode.Local), 1), / secrets=none/)
})

test('StartupLine reports secrets=none for an empty-string provisioned-secrets file path', () =>
{
    const config = { ...Fixture.Config(DeploymentMode.Local), provisionedSecretsFile: '' }
    assert.match(ServerBootstrap.StartupLine(config, 1), / secrets=none/)
})

test('ComposeOptions threads drainTimeoutMs through to the host options', () =>
{
    const config = { ...Fixture.Config(DeploymentMode.Local), drainTimeoutMs: 30000 }
    const options = ServerBootstrap.ComposeOptions(config, Fixture.Provisioning())
    assert.equal(options.drainTimeoutMs, 30000)
})

test('StartupLine reports the drain window', () =>
{
    const config = { ...Fixture.Config(DeploymentMode.Local), drainTimeoutMs: 25000 }
    assert.match(ServerBootstrap.StartupLine(config, 1), / drain=25000/)
})

class DrainFixture
{
    public static Worker(): ServerConfig
    {
        return { ...Fixture.Config(DeploymentMode.Local), tls: { certFile: '/c', keyFile: '/k', caFile: '/a' }, drainTimeoutMs: 31000 } as unknown as ServerConfig
    }
}

test('ComposeWorkerOptions threads drainTimeoutMs', () =>
{
    const options = ServerBootstrap.ComposeWorkerOptions(DrainFixture.Worker(), Fixture.Provisioning())
    assert.equal(options.drainTimeoutMs, 31000)
})

test('WorkerStartupLine reports the drain window', () =>
{
    assert.match(ServerBootstrap.WorkerStartupLine(DrainFixture.Worker()), / drain=31000/)
})
