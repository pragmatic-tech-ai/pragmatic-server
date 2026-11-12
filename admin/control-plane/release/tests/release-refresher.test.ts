import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ReleaseRefreshResult } from '../release-catalog.js'
import { ReleaseRefresher, type IReleaseRefreshSource } from '../release-refresher.js'

/** A catalogue whose refreshes stay open until the test settles them, so overlapping calls can be observed. */
class HeldCatalog implements IReleaseRefreshSource
{
    public Calls = 0
    private settle: Array<{ resolve: (r: ReleaseRefreshResult) => void; reject: (e: Error) => void }> = []

    public Refresh(): Promise<ReleaseRefreshResult>
    {
        this.Calls++
        return new Promise((resolve, reject) => this.settle.push({ resolve, reject }))
    }

    public Resolve(result: ReleaseRefreshResult): void
    {
        this.settle.shift()!.resolve(result)
    }

    public Reject(error: Error): void
    {
        this.settle.shift()!.reject(error)
    }
}

class Fx
{
    /** Lets a refresh that was just asked for reach the catalogue. */
    public static Settle(): Promise<void>
    {
        return new Promise(resolve => setImmediate(resolve))
    }

    public static Result(imported: string): ReleaseRefreshResult
    {
        return { imported: [imported], rejected: [], unchanged: 0, shadowed: [] }
    }
}

describe('ReleaseRefresher', () =>
{
    it('runs one refresh for callers that arrive while it is in flight, and hands each the same result', async () =>
    {
        const catalog = new HeldCatalog()
        const refresher = new ReleaseRefresher(catalog)
        const first = refresher.Refresh()
        await Fx.Settle()
        const second = refresher.Refresh()
        await Fx.Settle()
        assert.equal(catalog.Calls, 1)
        catalog.Resolve(Fx.Result('1.0.0'))
        assert.deepEqual(await first, Fx.Result('1.0.0'))
        assert.deepEqual(await second, Fx.Result('1.0.0'))
    })

    it('starts a fresh refresh once the previous one settled', async () =>
    {
        const catalog = new HeldCatalog()
        const refresher = new ReleaseRefresher(catalog)
        const first = refresher.Refresh()
        await Fx.Settle()
        catalog.Resolve(Fx.Result('1.0.0'))
        await first
        const second = refresher.Refresh()
        await Fx.Settle()
        assert.equal(catalog.Calls, 2)
        catalog.Resolve(Fx.Result('2.0.0'))
        assert.deepEqual(await second, Fx.Result('2.0.0'))
    })

    it('hands a failure to every waiter, then lets the next call try again', async () =>
    {
        const catalog = new HeldCatalog()
        const refresher = new ReleaseRefresher(catalog)
        const first = refresher.Refresh()
        const second = refresher.Refresh()
        await Fx.Settle()
        catalog.Reject(new Error('down'))
        await assert.rejects(first, /down/)
        await assert.rejects(second, /down/)
        const third = refresher.Refresh()
        await Fx.Settle()
        assert.equal(catalog.Calls, 2)
        catalog.Resolve(Fx.Result('3.0.0'))
        assert.deepEqual(await third, Fx.Result('3.0.0'))
    })
})
