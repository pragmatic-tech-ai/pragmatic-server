import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IdentityConfig, DelegationDepth, Role } from '@pragmatic-tech-ai/todl-identity'
import { NodePlatform } from '../node-platform.js'

class PlatformFixture
{
    public static TempDir(): string
    {
        return mkdtempSync(join(tmpdir(), 'nodeplat-'))
    }

    public static KeyFile(dir: string): string
    {
        const path = join(dir, 'master.key')
        writeFileSync(path, Buffer.alloc(32, 3))
        return path
    }
}

test('CreateStorageProviderRegistry yields storage that reads back what it writes', async () =>
{
    const dir = PlatformFixture.TempDir()
    const storage = new NodePlatform().CreateStorageProviderRegistry().CreateStorage(dir)
    await storage.WriteText('a.txt', 'hello')
    assert.equal(await storage.ReadText('a.txt'), 'hello')
})

test('CreateIdentityStores returns a set whose secret store round-trips', async () =>
{
    const dir = PlatformFixture.TempDir()
    const stores = await new NodePlatform().CreateIdentityStores(dir, Buffer.alloc(32, 9))
    await stores.Secrets.Put('ref', 'sekret')
    assert.equal(await stores.Secrets.Get('ref'), 'sekret')
})

test('ResolveMasterKey reads a 32-byte key by reference', () =>
{
    const dir = PlatformFixture.TempDir()
    const key = new NodePlatform().ResolveMasterKey({ keyFilePath: PlatformFixture.KeyFile(dir) })
    assert.equal(key.length, 32)
})

test('ResolveMasterKey rejects a wrong-length key', () =>
{
    const dir = PlatformFixture.TempDir()
    const bad = join(dir, 'bad.key')
    writeFileSync(bad, Buffer.alloc(16, 1))
    assert.throws(() => new NodePlatform().ResolveMasterKey({ keyFilePath: bad }))
})

test('NodePlatform CreateTenantConfigStore round-trips a tenant config', async () =>
{
    const root = mkdtempSync(join(tmpdir(), 'ps-tcfg-'))
    try
    {
        const platform = new NodePlatform()
        const store = await platform.CreateTenantConfigStore(root)
        assert.equal(await store.Get('t1'), null)
        await store.Save('t1', new IdentityConfig('pack-1', DelegationDepth.FullAuthz, new Map([['s', 'v']]), new Map([['g', Role.Editor]]), new Map()))
        const got = (await store.Get('t1'))!
        assert.equal(got.PackId, 'pack-1')
        assert.equal(got.ProviderSettings.get('s'), 'v')
        assert.equal(got.DelegationDepth, DelegationDepth.FullAuthz)
        assert.equal(got.GroupRoleMap.get('g'), Role.Editor)
        assert.deepEqual([...(await store.List())], ['t1'])
    }
    finally
    {
        rmSync(root, { recursive: true, force: true })
    }
})
