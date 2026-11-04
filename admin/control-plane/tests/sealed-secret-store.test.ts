import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SealedSecretStore, SealedSecretUnreadableError, SealedSecretFileError } from '../sealed-secret-store.js'

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

test('a failed Put leaves no unpersisted value behind', async () =>
{
    await SealedFixture.WithDir(async file =>
    {
        const sub = join(file, '..', 'sub')
        const target = join(sub, SealedSecretStore.FileName)
        const store = await SealedSecretStore.Open(target, randomBytes(32))
        await writeFile(sub, 'blocker')
        await assert.rejects(store.Put(SealedFixture.Ref, randomBytes(32)))
        assert.equal(await store.Get(SealedFixture.Ref), undefined)
    })
})

test('a tampered blob throws a fixed unreadable error', async () =>
{
    await SealedFixture.WithDir(async file =>
    {
        const key = randomBytes(32)
        const store = await SealedSecretStore.Open(file, key)
        await store.Put(SealedFixture.Ref, randomBytes(32))
        const doc = JSON.parse(await readFile(file, SealedFixture.Encoding))
        doc.sealed[SealedFixture.Ref] = 'AAAA' + doc.sealed[SealedFixture.Ref].slice(4)
        await writeFile(file, JSON.stringify(doc))
        const reopened = await SealedSecretStore.Open(file, key)
        await assert.rejects(reopened.Get(SealedFixture.Ref), (e: Error) => e instanceof SealedSecretUnreadableError && e.message === 'A sealed secret could not be read.')
    })
})

test('a wrong master key throws on a present entry', async () =>
{
    await SealedFixture.WithDir(async file =>
    {
        const store = await SealedSecretStore.Open(file, randomBytes(32))
        await store.Put(SealedFixture.Ref, randomBytes(32))
        const other = await SealedSecretStore.Open(file, randomBytes(32))
        await assert.rejects(other.Get(SealedFixture.Ref), SealedSecretUnreadableError)
    })
})

test('a blob swapped between refs is rejected', async () =>
{
    await SealedFixture.WithDir(async file =>
    {
        const key = randomBytes(32)
        const store = await SealedSecretStore.Open(file, key)
        await store.Put('a', randomBytes(32))
        await store.Put('b', randomBytes(32))
        const doc = JSON.parse(await readFile(file, SealedFixture.Encoding))
        const swapped = { sealed: { a: doc.sealed.b, b: doc.sealed.a } }
        await writeFile(file, JSON.stringify(swapped))
        const reopened = await SealedSecretStore.Open(file, key)
        await assert.rejects(reopened.Get('a'), SealedSecretUnreadableError)
    })
})

test('Open rejects truncated, garbage and wrong-shape files with a fixed error', async () =>
{
    const bodies = ['{"sealed":{"a":', 'not json at all', 'null', '{"sealed":null}', '{"sealed":5}', '{"sealed":{"a":5}}', '[]', '{"sealed":[]}']
    for (const body of bodies)
    {
        await SealedFixture.WithDir(async file =>
        {
            await writeFile(file, body)
            await assert.rejects(SealedSecretStore.Open(file, randomBytes(32)), (e: Error) => e instanceof SealedSecretFileError && e.message === 'The sealed secret file is invalid.' && e.cause === undefined)
        })
    }
})

test('refs containing the separator are rejected without touching the store', async () =>
{
    await SealedFixture.WithDir(async file =>
    {
        const store = await SealedSecretStore.Open(file, randomBytes(32))
        const bad = 'a\u0000b'
        const fixed = (e: Error) => e.message === 'A sealed secret reference is invalid.'
        await assert.rejects(async () => store.Put(bad, randomBytes(8)), fixed)
        await assert.rejects(async () => store.Get(bad), fixed)
        await assert.rejects(async () => store.Delete(bad), fixed)
    })
})
