import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ReleaseRefreshResult } from '../release-catalog.js'
import { ReleaseRefresher, type IReleaseRefreshSource } from '../release-refresher.js'
import { ReleasePoll, type IReleasePollLog } from '../release-poll.js'
import { ReleaseRegistryUnavailableError } from '../../rollout-errors.js'

class RecordingLog implements IReleasePollLog
{
    public readonly Infos: string[] = []
    public readonly Warnings: string[] = []

    public Info(line: string): void
    {
        this.Infos.push(line)
    }

    public Warn(line: string): void
    {
        this.Warnings.push(line)
    }
}

/** Answers each refresh from a queue of outcomes (a result, or an error to throw). */
class ScriptedCatalog implements IReleaseRefreshSource
{
    public Calls = 0

    public constructor(private readonly outcomes: Array<ReleaseRefreshResult | Error>)
    {
    }

    public async Refresh(): Promise<ReleaseRefreshResult>
    {
        this.Calls++
        const next = this.outcomes.shift() ?? { imported: [], rejected: [], unchanged: 0, shadowed: [] }
        if (next instanceof Error)
        {
            throw next
        }
        return next
    }
}

class Fx
{
    public static readonly Secret = 'ghp_SECRET_in_an_inner_message'
    public static readonly CountsLine = 'Release poll: imported 2, rejected 1, unchanged 3, shadowed 1'
    public static readonly Result: ReleaseRefreshResult = { imported: ['4.0.0', '4.1.0'], rejected: ['4.2.0'], unchanged: 3, shadowed: ['1.0.0'] }
}

describe('ReleasePoll', () =>
{
    it('logs the counts of one refresh, never the versions', async () =>
    {
        const log = new RecordingLog()
        await new ReleasePoll(new ReleaseRefresher(new ScriptedCatalog([Fx.Result])), 1000, log).Tick()
        assert.deepEqual(log.Infos, [Fx.CountsLine])
        assert.deepEqual(log.Warnings, [])
    })

    it('logs the registry failure sentence and carries on', async () =>
    {
        const log = new RecordingLog()
        const poll = new ReleasePoll(new ReleaseRefresher(new ScriptedCatalog([new ReleaseRegistryUnavailableError(), Fx.Result])), 1000, log)
        await poll.Tick()
        await poll.Tick()
        assert.deepEqual(log.Warnings, ['Release poll failed: The release registry is unreachable or refused the credential'])
        assert.equal(log.Infos.length, 1)
    })

    it('logs only the error name for any other failure, so inner text never reaches the log', async () =>
    {
        const log = new RecordingLog()
        const inner = new TypeError('boom ' + Fx.Secret)
        await new ReleasePoll(new ReleaseRefresher(new ScriptedCatalog([inner])), 1000, log).Tick()
        assert.deepEqual(log.Warnings, ['Release poll failed: TypeError'])
        assert.ok(!log.Warnings.join().includes(Fx.Secret))
    })

    it('skips a tick while the previous one is still pending, so each refresh logs once', async () =>
    {
        const log = new RecordingLog()
        let release: (r: ReleaseRefreshResult) => void = () => undefined
        let calls = 0
        const held: IReleaseRefreshSource = { Refresh: () => new Promise(resolve => { calls++; release = resolve }) }
        const poll = new ReleasePoll(new ReleaseRefresher(held), 1000, log)
        const first = poll.Tick()
        const second = poll.Tick()
        await new Promise(resolve => setImmediate(resolve))
        release(Fx.Result)
        await Promise.all([first, second])
        assert.deepEqual(log.Infos, [Fx.CountsLine])
        assert.equal(calls, 1)
        const later = poll.Tick()
        await new Promise(resolve => setImmediate(resolve))
        release(Fx.Result)
        await later
        assert.equal(calls, 2, 'a later tick runs again')
        assert.equal(log.Infos.length, 2)
    })

    it('refreshes on its interval once started and stops on Stop', async () =>
    {
        const log = new RecordingLog()
        const catalog = new ScriptedCatalog([])
        const poll = new ReleasePoll(new ReleaseRefresher(catalog), 10, log)
        poll.Start()
        await new Promise(resolve => setTimeout(resolve, 80))
        poll.Stop()
        const seen = catalog.Calls
        assert.ok(seen >= 1)
        await new Promise(resolve => setTimeout(resolve, 40))
        assert.equal(catalog.Calls, seen)
    })
})
