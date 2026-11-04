import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SealedSecretStore } from '../sealed-secret-store.js'
import { ConsoleFingerprintKeys } from '../console-fingerprint-keys.js'

class KeysFixture
{
    public static readonly Prefix = 'fpkeys-'

    public static async WithKeys(body: (keys: ConsoleFingerprintKeys) => Promise<void>): Promise<void>
    {
        const dir = await mkdtemp(join(tmpdir(), KeysFixture.Prefix))
        try
        {
            const store = await SealedSecretStore.Open(join(dir, SealedSecretStore.FileName), randomBytes(32))
            await body(new ConsoleFingerprintKeys(store))
        }
        finally
        {
            await rm(dir, { recursive: true, force: true })
        }
    }
}

test('Ensure creates a 32-byte key once and returns it again', async () =>
{
    await KeysFixture.WithKeys(async keys =>
    {
        const first = await keys.Ensure('h1')
        assert.equal(first.length, ConsoleFingerprintKeys.KeyBytes)
        assert.deepEqual(await keys.Ensure('h1'), first)
        assert.deepEqual(await keys.Get('h1'), first)
        assert.equal(ConsoleFingerprintKeys.RefOf('h1'), 'console-fingerprint-key/h1')
    })
})

test('Ensure for two hives gives different keys', async () =>
{
    await KeysFixture.WithKeys(async keys =>
    {
        assert.notDeepEqual(await keys.Ensure('h1'), await keys.Ensure('h2'))
    })
})

test('concurrent Ensure for one hive yields one key', async () =>
{
    await KeysFixture.WithKeys(async keys =>
    {
        const [a, b] = await Promise.all([keys.Ensure('h1'), keys.Ensure('h1')])
        assert.deepEqual(a, b)
        assert.deepEqual(await keys.Get('h1'), a)
    })
})

test('Remove forgets the key', async () =>
{
    await KeysFixture.WithKeys(async keys =>
    {
        await keys.Ensure('h1')
        await keys.Remove('h1')
        assert.equal(await keys.Get('h1'), undefined)
    })
})
