import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fstatSync } from 'node:fs'
import { AtomicJsonFile, type AtomicWriteOptions } from '../atomic-json-file.js'
import { SealedSecretStore, SealedSecretUnreadableError, SealedSecretFileError } from '../sealed-secret-store.js'

class SealedFixture
{
    public static readonly Prefix = 'sealed-'
    public static readonly Encoding = 'utf8'
    public static readonly Redacted = '"[SealedSecretStore: values redacted]"'
    public static readonly Ref = 'a/b'
    public static readonly DirectorySyncLog = '[sealed-secrets] the sealed file is saved, but its directory could not be synced:'
    public static readonly SyncFailureName = 'SyncFailure'
    public static readonly SecretText = 'EIO at /secret/path'

    /** A directory-sync error with its own name, so the test can tell the name from the message. */
    public static readonly SyncFailure = class SyncFailure extends Error
    {
        public constructor(message: string)
        {
            super(message)
            this.name = SealedFixture.SyncFailureName
        }
    }

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

test('every Put syncs the temp file to disk (fsync is passed)', async () =>
{
    await SealedFixture.WithDir(async file =>
    {
        const probe = await open(`${file}.probe`, 'w')
        const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> }
        await probe.close()
        const sync = mock.method(proto, 'sync')
        try
        {
            const store = await SealedSecretStore.Open(file, randomBytes(32))
            await store.Put(SealedFixture.Ref, randomBytes(8))
            const afterFirst = sync.mock.callCount()
            assert.ok(afterFirst >= 1)
            await store.Put(SealedFixture.Ref, randomBytes(8))
            assert.ok(sync.mock.callCount() > afterFirst)
        }
        finally
        {
            sync.mock.restore()
        }
    })
})

test('a directory sync failure after the rename still resolves the Put and logs its sentence and error name once', async () =>
{
    await SealedFixture.WithDir(async file =>
    {
        const logged: unknown[][] = []
        const log = mock.method(console, 'error', (...args: unknown[]) => { logged.push(args) })
        // Drives the store's own callback on every platform (the real directory sync runs on POSIX only).
        const original = AtomicJsonFile.Write
        const write = mock.method(AtomicJsonFile, 'Write', async (path: string, value: unknown, indent?: number, options?: AtomicWriteOptions) =>
        {
            await original.call(AtomicJsonFile, path, value, indent, { ...options, onDirectorySyncFailure: undefined })
            assert.equal(options?.fsync, true)
            options?.onDirectorySyncFailure?.(new SealedFixture.SyncFailure(SealedFixture.SecretText))
        })
        try
        {
            const key = randomBytes(32)
            const value = randomBytes(8)
            const store = await SealedSecretStore.Open(file, key)
            await store.Put(SealedFixture.Ref, value)
            assert.deepEqual(await store.Get(SealedFixture.Ref), value, 'memory follows the disk')
            assert.deepEqual(await (await SealedSecretStore.Open(file, key)).Get(SealedFixture.Ref), value)
            assert.equal(logged.length, 1)
            assert.deepEqual(logged[0], [SealedFixture.DirectorySyncLog, SealedFixture.SyncFailureName])
            assert.ok(!JSON.stringify(logged).includes(SealedFixture.SecretText))
        }
        finally
        {
            write.mock.restore()
            log.mock.restore()
        }
    })
})

test('a real failing directory sync on POSIX resolves the Put and logs once', { skip: process.platform === 'win32' }, async () =>
{
    await SealedFixture.WithDir(async file =>
    {
        const probe = await open(`${file}.probe`, 'w')
        const proto = Object.getPrototypeOf(probe) as { sync: (this: { fd: number }) => Promise<void> }
        await probe.close()
        const original = proto.sync
        const sync = mock.method(proto, 'sync', async function (this: { fd: number })
        {
            if (fstatSync(this.fd).isDirectory())
            {
                throw new SealedFixture.SyncFailure(SealedFixture.SecretText)
            }
            return original.call(this)
        })
        const logged: unknown[][] = []
        const log = mock.method(console, 'error', (...args: unknown[]) => { logged.push(args) })
        try
        {
            const key = randomBytes(32)
            const value = randomBytes(8)
            const store = await SealedSecretStore.Open(file, key)
            await store.Put(SealedFixture.Ref, value)
            assert.deepEqual(await store.Get(SealedFixture.Ref), value)
            assert.deepEqual(logged, [[SealedFixture.DirectorySyncLog, SealedFixture.SyncFailureName]])
        }
        finally
        {
            sync.mock.restore()
            log.mock.restore()
        }
    })
})

test('the sealed file is private to its owner', { skip: process.platform === 'win32' }, async () =>
{
    await SealedFixture.WithDir(async file =>
    {
        const store = await SealedSecretStore.Open(file, randomBytes(32))
        await store.Put(SealedFixture.Ref, randomBytes(8))
        assert.equal((await stat(file)).mode & 0o077, 0)
    })
})
