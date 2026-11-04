import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SealedSecretStore } from '../sealed-secret-store.js'

class SealedFixture
{
    public static readonly Prefix = 'sealed-'
    public static readonly Encoding = 'utf8'
    public static readonly Redacted = '"[SealedSecretStore: values redacted]"'
    public static readonly Ref = 'a/b'

    public static async WithDir(body: (file: string) => Promise<void>): Promise<void>
    {
        const dir = await mkdtemp(join(tmpdir(), SealedFixture.Prefix))
        try
        {
            await body(join(dir, SealedSecretStore.FileName))
        }
        finally
        {
            await rm(dir, { recursive: true, force: true })
        }
    }
}

test('round-trips bytes across reopen', async () =>
{
    await SealedFixture.WithDir(async file =>
    {
        const key = randomBytes(32)
        const value = randomBytes(32)
        const store = await SealedSecretStore.Open(file, key)
        await store.Put(SealedFixture.Ref, value)
        const reopened = await SealedSecretStore.Open(file, key)
        assert.deepEqual(await reopened.Get(SealedFixture.Ref), value)
        assert.equal(await reopened.Get('missing'), undefined)
    })
})

test('the file holds neither the bytes nor their base64', async () =>
{
    await SealedFixture.WithDir(async file =>
    {
        const value = randomBytes(32)
        const store = await SealedSecretStore.Open(file, randomBytes(32))
        await store.Put(SealedFixture.Ref, value)
        const text = await readFile(file, SealedFixture.Encoding)
        assert.ok(!text.includes(value.toString('base64')))
        assert.ok(!text.includes(value.toString('hex')))
    })
})

test('another master key reads nothing', async () =>
{
    await SealedFixture.WithDir(async file =>
    {
        const store = await SealedSecretStore.Open(file, randomBytes(32))
        await store.Put(SealedFixture.Ref, randomBytes(32))
        const other = await SealedSecretStore.Open(file, randomBytes(32))
        assert.equal(await other.Get(SealedFixture.Ref), undefined)
    })
})

test('Delete persists', async () =>
{
    await SealedFixture.WithDir(async file =>
    {
        const key = randomBytes(32)
        const store = await SealedSecretStore.Open(file, key)
        await store.Put(SealedFixture.Ref, randomBytes(8))
        await store.Delete(SealedFixture.Ref)
        const reopened = await SealedSecretStore.Open(file, key)
        assert.equal(await reopened.Get(SealedFixture.Ref), undefined)
    })
})

test('two concurrent Puts both persist', async () =>
{
    await SealedFixture.WithDir(async file =>
    {
        const key = randomBytes(32)
        const store = await SealedSecretStore.Open(file, key)
        const a = randomBytes(32)
        const b = randomBytes(32)
        await Promise.all([store.Put('one', a), store.Put('two', b), store.Delete('none')])
        const reopened = await SealedSecretStore.Open(file, key)
        assert.deepEqual(await reopened.Get('one'), a)
        assert.deepEqual(await reopened.Get('two'), b)
    })
})

test('JSON.stringify of the store is redacted', async () =>
{
    await SealedFixture.WithDir(async file =>
    {
        const store = await SealedSecretStore.Open(file, randomBytes(32))
        assert.equal(JSON.stringify(store), SealedFixture.Redacted)
        assert.ok(!String(store).includes('{'))
    })
})
