import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeStorage } from '@pragmatic-tech-ai/todl-runtime'
import { ResponseError } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { StorageChangedPayload } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { RemoteStorageHandlers } from '../../storage/remote-storage-handlers.js'
import { SourceChangeBridge } from '../source-change-bridge.js'

class BridgeFx
{
    public readonly Storage = new FakeStorage()
    public readonly DidChangeCalls: { uri: string; text: string }[] = []
    public readonly Changes: StorageChangedPayload[] = []
    public readonly Handlers: RemoteStorageHandlers

    public constructor(throwOnDidChange: boolean = false)
    {
        const language = { DidChange: (uri: string, text: string) =>
        {
            if (throwOnDidChange)
            {
                throw new Error('language service failure')
            }
            this.DidChangeCalls.push({ uri, text })
        } } as unknown as ILanguageService
        const bridge = new SourceChangeBridge(language)
        bridge.Changed.subscribe(change => this.Changes.push(change))
        this.Handlers = new RemoteStorageHandlers(() => this.Storage, bridge)
    }

    public Uri(path: string): string
    {
        const root = this.Storage.Root
        return (root.endsWith('/') ? root : root + '/') + path
    }
}

test('WriteText drives exactly one DidChange and one changed/added emission', async () =>
{
    const fx = new BridgeFx()
    await fx.Handlers.WriteText({ Path: 'a/x.todl', Content: 'hi' })
    assert.deepEqual(fx.DidChangeCalls, [{ uri: fx.Uri('a/x.todl'), text: 'hi' }])
    assert.deepEqual(fx.Changes, [{ Kind: 'added', Path: 'a/x.todl', IsDirectory: false }])
    await fx.Handlers.WriteText({ Path: 'a/x.todl', Content: 'ho' })
    assert.deepEqual(fx.DidChangeCalls[1], { uri: fx.Uri('a/x.todl'), text: 'ho' })
    assert.equal(fx.DidChangeCalls.length, 2)
    assert.deepEqual(fx.Changes[1], { Kind: 'changed', Path: 'a/x.todl', IsDirectory: false })
})

test('WriteBytes emits a change but does not call DidChange', async () =>
{
    const fx = new BridgeFx()
    await fx.Handlers.WriteBytes({ Path: 'b.bin', BytesBase64: Buffer.from([1, 2, 3]).toString('base64') })
    assert.equal(fx.DidChangeCalls.length, 0)
    assert.deepEqual(fx.Changes, [{ Kind: 'added', Path: 'b.bin', IsDirectory: false }])
})

test('Delete emits removed; CreateDirectory emits added as a directory; neither calls DidChange', async () =>
{
    const fx = new BridgeFx()
    await fx.Handlers.CreateDirectory({ Path: 'd' })
    await fx.Handlers.WriteText({ Path: 'd/a.txt', Content: 'x' })
    fx.Changes.length = 0
    fx.DidChangeCalls.length = 0
    await fx.Handlers.Delete({ Path: 'd/a.txt' })
    await fx.Handlers.CreateDirectory({ Path: 'e' })
    assert.deepEqual(fx.Changes, [{ Kind: 'removed', Path: 'd/a.txt', IsDirectory: false }, { Kind: 'added', Path: 'e', IsDirectory: true }])
    assert.equal(fx.DidChangeCalls.length, 0)
})

test('Rename emits removed(From) then added(To)', async () =>
{
    const fx = new BridgeFx()
    await fx.Handlers.WriteText({ Path: 'a.txt', Content: 'x' })
    fx.Changes.length = 0
    await fx.Handlers.Rename({ From: 'a.txt', To: 'b.txt' })
    assert.deepEqual(fx.Changes, [{ Kind: 'removed', Path: 'a.txt', IsDirectory: false }, { Kind: 'added', Path: 'b.txt', IsDirectory: false }])
})

test('a rejected mutation emits nothing', async () =>
{
    const fx = new BridgeFx()
    await assert.rejects(() => fx.Handlers.Delete({ Path: '' }), ResponseError)
    await assert.rejects(() => fx.Handlers.WriteText({ Path: '../x', Content: 'a' }), ResponseError)
    await assert.rejects(() => fx.Handlers.WriteBytes({ Path: 'x', BytesBase64: '!!' }), ResponseError)
    assert.equal(fx.Changes.length, 0)
    assert.equal(fx.DidChangeCalls.length, 0)
})

test('a throwing DidChange still emits the change and does not fail the committed write', async () =>
{
    const fx = new BridgeFx(true)
    await fx.Handlers.WriteText({ Path: 'a/x.todl', Content: 'hi' })
    assert.deepEqual(fx.Changes, [{ Kind: 'added', Path: 'a/x.todl', IsDirectory: false }])
    assert.equal(await fx.Storage.ReadText('a/x.todl'), 'hi')
})

test('a text write to a path that is not a tracked .todl source emits but does not call DidChange', async () =>
{
    const fx = new BridgeFx()
    await fx.Handlers.WriteText({ Path: 'README.md', Content: 'hi' })
    await fx.Handlers.WriteText({ Path: 'node_modules/p/x.todl', Content: 'hi' })
    assert.equal(fx.DidChangeCalls.length, 0)
    assert.equal(fx.Changes.length, 2)
})

test('deleting and renaming a directory report IsDirectory true', async () =>
{
    const fx = new BridgeFx()
    await fx.Handlers.CreateDirectory({ Path: 'd' })
    await fx.Handlers.CreateDirectory({ Path: 'e' })
    fx.Changes.length = 0
    await fx.Handlers.Rename({ From: 'd', To: 'd2' })
    await fx.Handlers.Delete({ Path: 'e' })
    assert.deepEqual(fx.Changes, [
        { Kind: 'removed', Path: 'd', IsDirectory: true },
        { Kind: 'added', Path: 'd2', IsDirectory: true },
        { Kind: 'removed', Path: 'e', IsDirectory: true },
    ])
})
