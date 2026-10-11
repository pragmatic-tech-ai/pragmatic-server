import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthMethod, Role, ResourceKind, PresentedSecret, Credential, AuthenticatedResult } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticServer } from '../../pragmatic-server.js'

class IdentityFixture
{
    public static Dirs(): { identityRoot: string; packagesRoot: string; keyEnv: string }
    {
        const identityRoot = mkdtempSync(join(tmpdir(), 'ps-id-'))
        const packagesRoot = mkdtempSync(join(tmpdir(), 'ps-pkg-'))
        const keyEnv = 'PS_IT_KEY'
        process.env[keyEnv] = randomBytes(32).toString('base64')
        return { identityRoot, packagesRoot, keyEnv }
    }

    public static Cleanup(identityRoot: string, packagesRoot: string, keyEnv: string): void
    {
        rmSync(identityRoot, { recursive: true, force: true })
        rmSync(packagesRoot, { recursive: true, force: true })
        delete process.env[keyEnv]
    }

    public static Options(identityRoot: string, packagesRoot: string, keyEnv: string)
    {
        return {
            packagesRoot,
            identity: {
                identityRoot,
                masterKey: { base64Env: keyEnv },
                tenant: { id: 't1', displayName: 'Tenant One' },
                bootstrap: { adminEmail: 'admin@x.io', adminPrincipalId: 'admin', adminPasswordRef: 't1/bootstrap/admin', ownerGrant: true },
            },
        }
    }
}

test('Start builds the identity pack and Pack resolves it', async () =>
{
    const { identityRoot, packagesRoot, keyEnv } = IdentityFixture.Dirs()
    const server = new PragmaticServer(IdentityFixture.Options(identityRoot, packagesRoot, keyEnv))
    try
    {
        await server.Start()
        const pack = await server.Pack()
        assert.ok(pack.AuthenticatorFor(AuthMethod.Local))
        assert.equal(server.Tenant().Id, 't1')
    }
    finally
    {
        await server.Dispose()
        IdentityFixture.Cleanup(identityRoot, packagesRoot, keyEnv)
    }
})

test('bootstrap seeds an Owner admin when its password secret is present, and is idempotent', async () =>
{
    const { identityRoot, packagesRoot, keyEnv } = IdentityFixture.Dirs()
    const options = IdentityFixture.Options(identityRoot, packagesRoot, keyEnv)
    const first = new PragmaticServer(options)
    await first.Start()
    // Pre-store the admin password by reference, then re-seed: a real deployment stores it before first run.
    const pack1 = await first.Pack()
    await pack1.Secrets.Put(options.identity.bootstrap!.adminPasswordRef, 'admin-pw-12345')
    await first.SeedBootstrapForTest()
    await first.Dispose()

    const second = new PragmaticServer(options)
    try
    {
        await second.Start() // second seed is a no-op (account already exists); must not throw
        const pack = await second.Pack()
        const result = await pack.AuthenticatorFor(AuthMethod.Local)!.Authenticate(new Credential(AuthMethod.Local, 'admin@x.io'), new PresentedSecret('admin-pw-12345'), second.Tenant())
        assert.ok(result instanceof AuthenticatedResult)
        const grants = await pack.Grants.GrantsFor('admin', second.Tenant())
        assert.ok(grants.some(grant => grant.Role === Role.Owner))
    }
    finally
    {
        await second.Dispose()
        IdentityFixture.Cleanup(identityRoot, packagesRoot, keyEnv)
    }
})

test('bootstrap repairs a missing Owner grant on an existing account, idempotently', async () =>
{
    const { identityRoot, packagesRoot, keyEnv } = IdentityFixture.Dirs()
    const base = IdentityFixture.Options(identityRoot, packagesRoot, keyEnv)
    const withoutGrant = { ...base, identity: { ...base.identity, bootstrap: { ...base.identity.bootstrap, ownerGrant: false } } }
    const withGrant = { ...base, identity: { ...base.identity, bootstrap: { ...base.identity.bootstrap, ownerGrant: true } } }
    const first = new PragmaticServer(withoutGrant)
    await first.Start()
    const pack1 = await first.Pack()
    await pack1.Secrets.Put(withoutGrant.identity.bootstrap.adminPasswordRef, 'admin-pw-12345')
    await first.SeedBootstrapForTest()
    assert.equal((await pack1.Grants.GrantsFor('admin', first.Tenant())).length, 0)
    await first.Dispose()

    const second = new PragmaticServer(withGrant)
    try
    {
        await second.Start() // account exists, grant missing: bootstrap repairs it
        const pack = await second.Pack()
        const grants = await pack.Grants.GrantsFor('admin', second.Tenant())
        assert.equal(grants.length, 1)
        assert.equal(grants[0].Role, Role.Owner)
        assert.equal(grants[0].Resource.Kind, ResourceKind.Tenant)
        assert.equal(grants[0].Resource.TenantId, 't1')
        await second.SeedBootstrapForTest()
        assert.equal((await pack.Grants.GrantsFor('admin', second.Tenant())).length, 1)
    }
    finally
    {
        await second.Dispose()
        IdentityFixture.Cleanup(identityRoot, packagesRoot, keyEnv)
    }
})
