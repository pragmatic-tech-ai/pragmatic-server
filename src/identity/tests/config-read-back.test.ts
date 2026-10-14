import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IdentityConfig, DelegationDepth, Role } from '@pragmatic-tech-ai/todl-identity'
import { OidcSettingKeys } from '@pragmatic-tech-ai/todl-identity-cloud'
import { PragmaticServer } from '../../pragmatic-server.js'
import { ProvisionedSecretSource } from '../../config/provisioned-secret-source.js'

class ReadBackFixture
{
    public static readonly TenantId = 't1'
    public static readonly KeyEnv = 'PS_RB_KEY'
    public static readonly GroupName = 'ops'
    public static readonly GenericOidcPackId = 'generic-oidc'
    public static readonly SeedSecretRef = 't1/oidc/seed-secret'
    public static readonly StoredSecretRef = 't1/oidc/stored-secret'
    public static readonly SeedSecretValue = 'seed-secret-value'
    public static readonly StoredSecretValue = 'stored-secret-value'

    public static OidcConfig(secretRef: string): IdentityConfig
    {
        const settings = new Map<string, string>([
            [OidcSettingKeys.Issuer, 'https://issuer.example'],
            [OidcSettingKeys.DiscoveryUrl, 'https://issuer.example/.well-known/openid-configuration'],
            [OidcSettingKeys.ClientId, 'client-1'],
            [OidcSettingKeys.RedirectUri, 'https://app.example/cb'],
            [OidcSettingKeys.SecretRef, secretRef],
        ])
        return new IdentityConfig(ReadBackFixture.GenericOidcPackId, DelegationDepth.AuthnDirectory, settings, new Map(), new Map())
    }

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

test('a later boot composes the identity from the stored config, not the seed', async () =>
{
    const identityRoot = mkdtempSync(join(tmpdir(), 'ps-rb-id-'))
    const packagesRoot = mkdtempSync(join(tmpdir(), 'ps-rb-pkg-'))
    process.env[ReadBackFixture.KeyEnv] = randomBytes(32).toString('base64')
    const options = ReadBackFixture.Options(identityRoot, packagesRoot)
    const first = new PragmaticServer(options)
    try
    {
        await first.Start()
        assert.equal(first.Oidc(), undefined)
        await (await first.TenantConfigStore()).Save(ReadBackFixture.TenantId, ReadBackFixture.OidcConfig(ReadBackFixture.StoredSecretRef))
        await first.Dispose()

        const second = new PragmaticServer(options)
        try
        {
            await second.Start()
            assert.notEqual(second.Oidc(), undefined)
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

test('secret-ref provisioning reads the stored ProviderSettings, not the seed', async () =>
{
    const identityRoot = mkdtempSync(join(tmpdir(), 'ps-rb-id-'))
    const packagesRoot = mkdtempSync(join(tmpdir(), 'ps-rb-pkg-'))
    process.env[ReadBackFixture.KeyEnv] = randomBytes(32).toString('base64')
    const base = ReadBackFixture.Options(identityRoot, packagesRoot)
    const source = ProvisionedSecretSource.FromText(JSON.stringify({
        [ReadBackFixture.SeedSecretRef]: ReadBackFixture.SeedSecretValue,
        [ReadBackFixture.StoredSecretRef]: ReadBackFixture.StoredSecretValue,
    }))
    const options = {
        ...base,
        identity: { ...base.identity, identityConfig: ReadBackFixture.OidcConfig(ReadBackFixture.SeedSecretRef), provisionedSecrets: source },
    }
    const first = new PragmaticServer(options)
    try
    {
        await first.Start()
        const firstSecrets = (await first.Pack()).Secrets
        assert.equal(await firstSecrets.Get(ReadBackFixture.SeedSecretRef), ReadBackFixture.SeedSecretValue)
        assert.equal(await firstSecrets.Get(ReadBackFixture.StoredSecretRef), null)
        await (await first.TenantConfigStore()).Save(ReadBackFixture.TenantId, ReadBackFixture.OidcConfig(ReadBackFixture.StoredSecretRef))
        await first.Dispose()

        const second = new PragmaticServer(options)
        try
        {
            await second.Start()
            assert.equal(await (await second.Pack()).Secrets.Get(ReadBackFixture.StoredSecretRef), ReadBackFixture.StoredSecretValue)
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
