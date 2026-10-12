import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { newDb } from 'pg-mem'
import { Pool } from 'pg'
import { Tenant, TenantKind, IdentityConfig, DelegationDepth } from '@pragmatic-tech-ai/todl-identity'
import { PgSession, ObjectStoreProviderRegistry, CloudSecretManagerSecretStore } from '@pragmatic-tech-ai/todl-platform-cloud'
import { CloudPlatform } from '../cloud-platform.js'

class CloudFixture
{
    public static async Platform(): Promise<CloudPlatform>
    {
        const db = newDb()
        const pg = db.adapters.createPg()
        const pool = new pg.Pool() as unknown as Pool
        const session = new PgSession(pool)
        const secretManager = new CloudSecretManagerSecretStore()
        const keyRef = 'cluster/master-key'
        await secretManager.Put(keyRef, Buffer.alloc(32, 7).toString('base64'))
        const platform = await CloudPlatform.Create({ session, storage: new ObjectStoreProviderRegistry(), secretManager, masterKeyRef: keyRef })
        return platform
    }
}

test('Create resolves the 32-byte master key from the secret manager; ResolveMasterKey returns a defensive copy', async () =>
{
    const platform = await CloudFixture.Platform()
    const k1 = platform.ResolveMasterKey({ keyFilePath: 'ignored' })
    assert.equal(k1.length, 32)
    k1.fill(0)
    const k2 = platform.ResolveMasterKey({ keyFilePath: 'ignored' })
    assert.equal(k2[0], 7)
})

test('Create rejects a master key that is not 32 bytes, without leaking it', async () =>
{
    const db = newDb()
    const pg = db.adapters.createPg()
    const session = new PgSession(new pg.Pool() as unknown as Pool)
    const secretManager = new CloudSecretManagerSecretStore()
    const encoded = Buffer.alloc(16, 1).toString('base64')
    await secretManager.Put('k', encoded)
    await assert.rejects(() => CloudPlatform.Create({ session, storage: new ObjectStoreProviderRegistry(), secretManager, masterKeyRef: 'k' }), (e) =>
    {
        assert.ok(e instanceof Error)
        assert.ok(!e.message.includes(encoded))
        return /master key/.test(e.message)
    })
})

test('Create rejects a missing key reference with a distinct message', async () =>
{
    const db = newDb()
    const pg = db.adapters.createPg()
    const session = new PgSession(new pg.Pool() as unknown as Pool)
    const secretManager = new CloudSecretManagerSecretStore()
    await assert.rejects(() => CloudPlatform.Create({ session, storage: new ObjectStoreProviderRegistry(), secretManager, masterKeyRef: 'absent' }), (e) =>
    {
        assert.ok(e instanceof Error)
        assert.ok(!e.message.includes('absent'))
        return /reference not found/.test(e.message) && !/32 bytes/.test(e.message)
    })
})

test('concurrent CreateIdentityStores on a cold platform share one SQL store set', async () =>
{
    const platform = await CloudFixture.Platform()
    const key = platform.ResolveMasterKey({ keyFilePath: 'x' })
    const [x, y] = await Promise.all([platform.CreateIdentityStores('tenants/a/identity', key), platform.CreateIdentityStores('tenants/b/identity', key)])
    assert.equal(x.Accounts, y.Accounts)
})

test('CreateIdentityStores yields a working set; two calls share the SQL stores but isolate Secrets', async () =>
{
    const platform = await CloudFixture.Platform()
    const key = platform.ResolveMasterKey({ keyFilePath: 'x' })
    const a = await platform.CreateIdentityStores('tenants/a/identity', key)
    const b = await platform.CreateIdentityStores('tenants/b/identity', key)
    assert.equal(a.Accounts, b.Accounts)  // shared SQL store instance (opened once -> reopen-safe on pg-mem)
    assert.notEqual(a.Secrets, b.Secrets)  // per-tenant Secrets
    const ta = new Tenant(`cp-${randomUUID()}`, TenantKind.Saas, 'A')
    await a.Accounts.CreateAccount(ta, 'a@x.io', 'pa', 'refA')
    assert.equal((await a.Accounts.FindByEmail(ta, 'a@x.io'))!.PrincipalId, 'pa')
    await a.Secrets.Put('refA', 'secretA')
    assert.equal(await a.Secrets.Get('refA'), 'secretA')
    assert.equal(await b.Secrets.Get('refA'), null)  // Secrets isolated by namespace
})

test('CreateTenantConfigStore is cached and round-trips through SQL', async () =>
{
    const platform = await CloudFixture.Platform()
    const s1 = await platform.CreateTenantConfigStore('ignored')
    const s2 = await platform.CreateTenantConfigStore('ignored')
    assert.equal(s1, s2)
    await s1.Save('tcfg-t1', new IdentityConfig('p', DelegationDepth.FullAuthz, new Map(), new Map(), new Map()))
    assert.equal((await s2.Get('tcfg-t1'))!.PackId, 'p')
})

test('CreatePackagesStorage and the registry come from the injected object store', async () =>
{
    const platform = await CloudFixture.Platform()
    const storage = platform.CreatePackagesStorage('pkgs/root')
    await storage.WriteText('a.txt', 'hello')
    assert.equal(await storage.ReadText('a.txt'), 'hello')
    assert.ok(platform.CreateStorageProviderRegistry())
    assert.ok(platform.CreatePromptService())
})
