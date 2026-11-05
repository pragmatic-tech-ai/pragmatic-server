import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { IdpAdminError, type IdpAdminAccount, type IdpAdminClient } from '../idp-admin-client.js'
import type { IdpConnection } from '../idp-workload-driver.js'
import { InHiveIdpAdmin, InHiveIdpUnavailableError } from '../in-hive-idp-admin.js'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import type { IProcessSpawner, ISpawnedProcess, PortForwardResult } from '../kubectl.js'
import type { TenantRecord } from '../platform-records.js'
import { SealedSecretStore } from '../sealed-secret-store.js'
import { OwnerAccountMissingError, OwnerNotRecordedError } from '../tenant-provisioning-service.js'
import { ConsoleFakeKubectl, ConsoleFakeOrchestrators, ConsoleInstallFixture } from './console-install-fakes.js'

class FakeTunnel implements ISpawnedProcess
{
    public readonly Stdout = new PassThrough()
    public Killed = 0

    public Kill(): void
    {
        this.Killed++
    }

    public OnExit(_cb: () => void): void
    {
    }
}

// A kubectl that can port-forward: hands out a fixed loopback port and records the forward.
class ForwardingKubectl extends ConsoleFakeKubectl
{
    public readonly Forwards: Array<[string, string, number]> = []
    public readonly Tunnel = new FakeTunnel()

    public async PortForward(namespace: string, target: string, remotePort: number, _spawner: IProcessSpawner): Promise<PortForwardResult>
    {
        this.Forwards.push([namespace, target, remotePort])
        return { LocalPort: 41000, Process: this.Tunnel }
    }
}

class FakeAdminClient
{
    public readonly Calls: unknown[][] = []
    public FailWith: Error | undefined
    // principalId -> password, as the IdP keeps it (an existing account keeps its password on a re-seed).
    public readonly Accounts = new Map<string, string>()

    public async EnsureRealm(tenantId: string, displayName: string): Promise<void>
    {
        this.Calls.push(['EnsureRealm', tenantId, displayName])
    }

    public async SeedAccount(tenantId: string, account: IdpAdminAccount): Promise<void>
    {
        this.Calls.push(['SeedAccount', tenantId, account.email, account.principalId, account.displayName])
        if (!this.Accounts.has(account.principalId))
        {
            this.Accounts.set(account.principalId, account.password)
        }
    }

    public async ResetPassword(tenantId: string, principalId: string, password: string): Promise<void>
    {
        this.Calls.push(['ResetPassword', tenantId, principalId, password])
        if (this.FailWith !== undefined)
        {
            throw this.FailWith
        }
    }
}

class Fixture
{
    public readonly Kubectl = new ForwardingKubectl()
    public readonly Client = new FakeAdminClient()
    public readonly Connections: IdpConnection[] = []
    public readonly Admin: InHiveIdpAdmin

    private constructor(private readonly dir: string, store: SealedSecretStore)
    {
        this.Admin = new InHiveIdpAdmin(new ConsoleFakeOrchestrators(this.Kubectl), store, { Spawn: () => { throw new Error('unused') } }, conn =>
        {
            this.Connections.push(conn)
            return this.Client as unknown as IdpAdminClient
        })
    }

    public static async Create(): Promise<Fixture>
    {
        const dir = mkdtempSync(join(tmpdir(), 'in-hive-idp-'))
        return new Fixture(dir, await SealedSecretStore.Open(join(dir, SealedSecretStore.FileName), randomBytes(32)))
    }

    public static Tenant(overrides: Partial<TenantRecord> = {}): TenantRecord
    {
        return { id: 'acme', clientId: 'c1', displayName: 'Acme', createdAt: '2026-01-01T00:00:00.000Z', ownerEmail: 'owner@acme.test', ownerPrincipalId: 'owner', ...overrides }
    }

    public Dispose(): void
    {
        rmSync(this.dir, { recursive: true, force: true })
    }
}

describe('InHiveIdpAdmin', () =>
{
    let fx: Fixture

    afterEach(() =>
    {
        fx?.Dispose()
    })

    it('ResetOwnerPassword resets over a loopback tunnel and returns the password once', async () =>
    {
        fx = await Fixture.Create()
        await fx.Admin.Remember('acme', Buffer.from('CA PEM'), 'admin.token.Zq')
        const result = await fx.Admin.ResetOwnerPassword(ConsoleInstallFixture.Hive('h1'), Fixture.Tenant())
        const idp = K8sManifestBuilder.IdpNameOf('acme')
        assert.deepEqual(fx.Kubectl.Forwards, [[idp, 'svc/' + idp, 9443]])
        assert.equal(fx.Connections[0]?.baseUrl, 'https://127.0.0.1:41000')
        assert.equal(fx.Connections[0]?.adminToken, 'admin.token.Zq')
        assert.equal(fx.Connections[0]?.ca.toString(), 'CA PEM')
        assert.deepEqual(fx.Client.Calls, [['ResetPassword', 'acme', 'owner', result.ownerPassword]])
        assert.equal(result.ownerEmail, 'owner@acme.test')
        assert.ok(result.ownerPassword.length >= 20)
        assert.equal(fx.Kubectl.Tunnel.Killed, 1)
    })

    it('the tunnel is killed even when the IdP call fails', async () =>
    {
        fx = await Fixture.Create()
        await fx.Admin.Remember('acme', Buffer.from('CA PEM'), 'admin.token.Zq')
        fx.Client.FailWith = new IdpAdminError(404, 'unknown_account')
        await assert.rejects(fx.Admin.ResetOwnerPassword(ConsoleInstallFixture.Hive('h1'), Fixture.Tenant()), OwnerAccountMissingError)
        assert.equal(fx.Kubectl.Tunnel.Killed, 1)
    })

    it('missing credentials are InHiveIdpUnavailableError', async () =>
    {
        fx = await Fixture.Create()
        await assert.rejects(fx.Admin.ResetOwnerPassword(ConsoleInstallFixture.Hive('h1'), Fixture.Tenant()),
            (err: unknown) => err instanceof InHiveIdpUnavailableError && err.message === 'This control plane holds no credentials for the in-hive identity provider. Install the console first.')
        await fx.Admin.Remember('acme', Buffer.from('CA PEM'), 'admin.token.Zq')
        await fx.Admin.Forget('acme')
        await assert.rejects(fx.Admin.SeedOwner(ConsoleInstallFixture.Hive('h1'), Fixture.Tenant()), InHiveIdpUnavailableError)
        assert.deepEqual(fx.Kubectl.Forwards, [])
    })

    it('a kubectl that cannot port-forward is InHiveIdpUnavailableError', async () =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'in-hive-idp-'))
        try
        {
            const store = await SealedSecretStore.Open(join(dir, SealedSecretStore.FileName), randomBytes(32))
            const admin = new InHiveIdpAdmin(new ConsoleFakeOrchestrators(new ConsoleFakeKubectl()), store)
            await admin.Remember('acme', Buffer.from('CA PEM'), 'admin.token.Zq')
            await assert.rejects(admin.SeedOwner(ConsoleInstallFixture.Hive('h1'), Fixture.Tenant()), /cannot open a tunnel/)
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('SeedOwner ensures the realm then seeds the recorded Owner principal, and a second call succeeds', async () =>
    {
        fx = await Fixture.Create()
        await fx.Admin.Remember('acme', Buffer.from('CA PEM'), 'admin.token.Zq')
        await fx.Admin.SeedOwner(ConsoleInstallFixture.Hive('h1'), Fixture.Tenant())
        const first = fx.Client.Accounts.get('owner')
        await fx.Admin.SeedOwner(ConsoleInstallFixture.Hive('h1'), Fixture.Tenant())
        assert.deepEqual(fx.Client.Calls, [
            ['EnsureRealm', 'acme', 'Acme'], ['SeedAccount', 'acme', 'owner@acme.test', 'owner', 'Acme'],
            ['EnsureRealm', 'acme', 'Acme'], ['SeedAccount', 'acme', 'owner@acme.test', 'owner', 'Acme'],
        ])
        assert.equal(fx.Client.Accounts.get('owner'), first)
        assert.equal(fx.Kubectl.Tunnel.Killed, 2)
    })

    it('no Owner recorded is OwnerNotRecordedError', async () =>
    {
        fx = await Fixture.Create()
        await fx.Admin.Remember('acme', Buffer.from('CA PEM'), 'admin.token.Zq')
        const { ownerEmail: _e, ...noOwner } = Fixture.Tenant()
        await assert.rejects(fx.Admin.ResetOwnerPassword(ConsoleInstallFixture.Hive('h1'), noOwner), OwnerNotRecordedError)
        await assert.rejects(fx.Admin.SeedOwner(ConsoleInstallFixture.Hive('h1'), noOwner), OwnerNotRecordedError)
        assert.deepEqual(fx.Kubectl.Forwards, [])
    })

    it('a missing principal id falls back to the shared Owner principal', async () =>
    {
        fx = await Fixture.Create()
        await fx.Admin.Remember('acme', Buffer.from('CA PEM'), 'admin.token.Zq')
        const { ownerPrincipalId: _p, ...legacy } = Fixture.Tenant()
        await fx.Admin.ResetOwnerPassword(ConsoleInstallFixture.Hive('h1'), legacy)
        assert.equal(fx.Client.Calls[0]?.[2], 'owner')
    })
})
