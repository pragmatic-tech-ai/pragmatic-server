import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeStorage } from '@pragmatic-tech-ai/todl-runtime'
import { ResponseError, ErrorCodes } from '@pragmatic-tech-ai/pragmatic-protocol'
import { RemoteStorageHandlers } from '../remote-storage-handlers.js'

class StorageFx
{
    public static readonly Binary = new Uint8Array([0, 1, 2, 127, 128, 200, 254, 255, 0xc3, 0x28])

    public static Handlers(storage: FakeStorage = new FakeStorage()): RemoteStorageHandlers
    {
        return new RemoteStorageHandlers(() => storage)
    }

    public static async Rejects(action: () => Promise<unknown>): Promise<void>
    {
        await assert.rejects(action, (error: unknown) => error instanceof ResponseError && error.code === ErrorCodes.InvalidParams)
    }
}

test('WriteBytes then ReadBytes is byte-exact', async () =>
{
    const handlers = StorageFx.Handlers()
    await handlers.WriteBytes({ Path: 'a/bin.dat', BytesBase64: Buffer.from(StorageFx.Binary).toString('base64') })
    const result = await handlers.ReadBytes({ Path: 'a/bin.dat' })
    assert.deepEqual(new Uint8Array(Buffer.from(result.BytesBase64, 'base64')), StorageFx.Binary)
})

test('WriteText and ReadText round-trip non-ASCII', async () =>
{
    const handlers = StorageFx.Handlers()
    await handlers.WriteText({ Path: 'x.todl', Content: 'caf\u00e9 \u2603' })
    assert.deepEqual(await handlers.ReadText({ Path: 'x.todl' }), { Content: 'caf\u00e9 \u2603' })
})

test('Exists, Delete', async () =>
{
    const handlers = StorageFx.Handlers()
    await handlers.WriteText({ Path: 'x.todl', Content: 'a' })
    assert.equal(await handlers.Exists({ Path: 'x.todl' }), true)
    await handlers.Delete({ Path: 'x.todl' })
    assert.equal(await handlers.Exists({ Path: 'x.todl' }), false)
})

test('CreateDirectory and Rename', async () =>
{
    const handlers = StorageFx.Handlers()
    await handlers.CreateDirectory({ Path: 'd' })
    assert.equal(await handlers.Exists({ Path: 'd' }), true)
    await handlers.WriteText({ Path: 'd/a.txt', Content: 'hi' })
    await handlers.Rename({ From: 'd/a.txt', To: 'd/b.txt' })
    assert.equal(await handlers.Exists({ Path: 'd/a.txt' }), false)
    assert.equal((await handlers.ReadText({ Path: 'd/b.txt' })).Content, 'hi')
})

test('List returns entries with IsDirectory', async () =>
{
    const handlers = StorageFx.Handlers()
    await handlers.CreateDirectory({ Path: 'root/sub' })
    await handlers.WriteText({ Path: 'root/file.txt', Content: 'f' })
    const entries = [...await handlers.List({ Path: 'root' })].sort((a, b) => a.Name.localeCompare(b.Name))
    assert.deepEqual(entries, [{ Name: 'file.txt', IsDirectory: false }, { Name: 'sub', IsDirectory: true }])
})

test('paths are resolved under the root: dot segments and backslashes normalize', async () =>
{
    const storage = new FakeStorage()
    const handlers = StorageFx.Handlers(storage)
    await handlers.WriteText({ Path: 'a/./b/../c.txt', Content: 'n' })
    assert.equal(await storage.Exists('a/c.txt'), true)
})

test('path escapes and absolute paths are rejected', async () =>
{
    const handlers = StorageFx.Handlers()
    await StorageFx.Rejects(() => handlers.ReadText({ Path: '../outside' }))
    await StorageFx.Rejects(() => handlers.ReadText({ Path: 'a/../../outside' }))
    await StorageFx.Rejects(() => handlers.WriteText({ Path: '..\\outside', Content: 'x' }))
    await StorageFx.Rejects(() => handlers.Exists({ Path: '/etc/passwd' }))
    await StorageFx.Rejects(() => handlers.Delete({ Path: 'C:\\Windows' }))
    await StorageFx.Rejects(() => handlers.Rename({ From: 'a', To: '../b' }))
    await StorageFx.Rejects(() => handlers.List({ Path: '//server/share' }))
})

test('no active source storage is rejected', async () =>
{
    const handlers = new RemoteStorageHandlers(() => undefined)
    await assert.rejects(() => handlers.Exists({ Path: 'a' }), (error: unknown) => error instanceof ResponseError && error.code === ErrorCodes.InvalidRequest)
})
