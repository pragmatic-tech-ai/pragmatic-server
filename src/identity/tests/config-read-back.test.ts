import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IdentityConfig, DelegationDepth, Role } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticServer } from '../../pragmatic-server.js'

class ReadBackFixture
{
    public static readonly TenantId = 't1'
    public static readonly KeyEnv = 'PS_RB_KEY'
    public static readonly GroupName = 'ops'

    public static Options(identityRoot: string, packagesRoot: string)
    {
        return {
            packagesRoot,
            identity: {
                identityRoot,
                masterKey: { base64Env: ReadBackFixture.KeyEnv },
                tenant: { id: ReadBackFixture.TenantId, displayName: 'Tenant One' },
            },
        }
    }
}

test('first boot seeds the config store; a later boot does not overwrite an admin-edited config', async () =>
{
    const identityRoot = mkdtempSync(join(tmpdir(), 'ps-rb-id-'))
    const packagesRoot = mkdtempSync(join(tmpdir(), 'ps-rb-pkg-'))
    process.env[ReadBackFixture.KeyEnv] = randomBytes(32).toString('base64')
    const options = ReadBackFixture.Options(identityRoot, packagesRoot)
    const first = new PragmaticServer(options)
    try
    {
        await first.Start()
        const store = await first.TenantConfigStore()
        const seeded = await store.Get(ReadBackFixture.TenantId)
        assert.notEqual(seeded, null)
        assert.equal(seeded!.DelegationDepth, DelegationDepth.FullAuthz)
        const edited = new IdentityConfig(seeded!.PackId, DelegationDepth.ExternalGrants, seeded!.ProviderSettings, new Map([[ReadBackFixture.GroupName, Role.Admin]]), seeded!.ClaimsMapping)
        await store.Save(ReadBackFixture.TenantId, edited)
        await first.Dispose()

        const second = new PragmaticServer(options)
        try
        {
            await second.Start()
            const after = await (await second.TenantConfigStore()).Get(ReadBackFixture.TenantId)
            assert.notEqual(after, null)
            assert.equal(after!.DelegationDepth, DelegationDepth.ExternalGrants)
            assert.equal(after!.GroupRoleMap.get(ReadBackFixture.GroupName), Role.Admin)
        }
        finally
        {
            await second.Dispose()
        }
    }
    finally
    {
        rmSync(identityRoot, { recursive: true, force: true })
        rmSync(packagesRoot, { recursive: true, force: true })
        delete process.env[ReadBackFixture.KeyEnv]
    }
})
