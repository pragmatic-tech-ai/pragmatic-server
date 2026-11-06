import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { Disposable, type IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import type { IAdvertTimer } from '../console-advert-sender.js'
import { ConsoleDomainApprovals } from '../console-domain-approvals.js'
import { DomainVerificationRecord } from '../domain-verification-record.js'
import { DomainVerificationRechecker } from '../domain-verification-rechecker.js'
import { DomainTxtVerifier, TxtLookupStatus, type ITxtResolver, type TxtLookup } from '../txt-resolver.js'

/** Answers each name from `byName` (NoRecord when absent), waits on `gate` when set, and records every name asked. */
class FakeTxtResolver implements ITxtResolver
{
    public readonly Names: string[] = []
    public readonly byName = new Map<string, TxtLookup>()
    public gate: Promise<void> | undefined
    public readonly entered: Promise<void>
    private signalEntered!: () => void

    public constructor()
    {
        this.entered = new Promise<void>(resolve => { this.signalEntered = resolve })
    }

    public async ResolveTxt(name: string): Promise<TxtLookup>
    {
        this.Names.push(name)
        this.signalEntered()
        if (this.gate !== undefined)
        {
            await this.gate
        }
        return this.byName.get(name) ?? { status: TxtLookupStatus.NoRecord, records: [] }
    }
}

/** A timer the test ticks by hand. */
class FakeTimer implements IAdvertTimer
{
    public intervalMs = 0
    public timers = 0
    public disposed = false
    private tick: (() => void) | undefined

    public Every(intervalMs: number, tick: () => void): IDisposable
    {
        this.intervalMs = intervalMs
        this.timers++
        this.tick = tick
        return new Disposable(() => { this.disposed = true })
    }

    public Tick(): void
    {
        this.tick?.()
    }
}

class FailingWriteApprovals extends ConsoleDomainApprovals
{
    public override async RecordCheck(): Promise<void>
    {
        throw new TypeError('disk full for secret-token')
    }
}

/** Counts finished RecordCheck writes, so a test waits for a background pass to end instead of sleeping. */
class CountingApprovals extends ConsoleDomainApprovals
{
    public writes = 0
    private waiter: (() => void) | undefined

    public override async RecordCheck(tenantId: string, domain: string, verified: boolean, checkedAt: string): Promise<void>
    {
        await super.RecordCheck(tenantId, domain, verified, checkedAt)
        this.writes++
        this.waiter?.()
    }

    public async WaitForWrites(count: number): Promise<void>
    {
        while (this.writes < count)
        {
            await new Promise<void>(resolve => { this.waiter = resolve })
        }
    }
}

describe('DomainVerificationRechecker', () =>
{
    const CheckedAt = new Date('2026-11-06T10:00:00.000Z')
    const OldCheck = '2026-01-01T00:00:00.000Z'
    let dir: string
    let approvals: ConsoleDomainApprovals
    let resolver: FakeTxtResolver
    let lines: string[]

    beforeEach(async () =>
    {
        dir = mkdtempSync(join(tmpdir(), 'recheck-'))
        approvals = new ConsoleDomainApprovals(join(dir, 'approvals.json'))
        await approvals.Load()
        resolver = new FakeTxtResolver()
        lines = []
    })

    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    const Rechecker = (timer: IAdvertTimer = new FakeTimer(), source: ConsoleDomainApprovals = approvals): DomainVerificationRechecker =>
        new DomainVerificationRechecker(source, new DomainTxtVerifier(resolver), timer, line => lines.push(line), () => CheckedAt)

    const Verify = async (tenant: string, domain: string): Promise<string> =>
    {
        await approvals.EnsureTokens(tenant, [domain])
        const token = approvals.VerificationOf(tenant, domain)!.token
        await approvals.RecordCheck(tenant, domain, true, OldCheck)
        return token
    }

    const Publish = (domain: string, token: string): void =>
    {
        resolver.byName.set('_pragmatic-verification.' + domain, { status: TxtLookupStatus.Found, records: [[DomainVerificationRecord.ValueFor(token)]] })
    }

    const Flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

    it('RunOnce keeps a still-present record verified and refreshes lastCheckedAt', async () =>
    {
        const token = await Verify('t1', 'acme.com')
        Publish('acme.com', token)
        const summary = await Rechecker().RunOnce()
        assert.deepEqual(summary, { checked: 1, unverified: 0, failed: 0 })
        assert.deepEqual(approvals.VerificationOf('t1', 'acme.com'), { token, verified: true, lastCheckedAt: CheckedAt.toISOString() })
        assert.deepEqual(lines, [])
    })

    it('RunOnce marks a domain whose record is gone or changed unverified, and deletes nothing', async () =>
    {
        const goneToken = await Verify('t1', 'gone.com')
        const changedToken = await Verify('t1', 'changed.com')
        await approvals.Approve('t1', 'gone.com')
        Publish('changed.com', DomainVerificationRecord.NewToken())
        const summary = await Rechecker().RunOnce()
        assert.deepEqual(summary, { checked: 2, unverified: 2, failed: 0 })
        assert.deepEqual(approvals.VerificationOf('t1', 'gone.com'), { token: goneToken, verified: false, lastCheckedAt: CheckedAt.toISOString() })
        assert.deepEqual(approvals.VerificationOf('t1', 'changed.com'), { token: changedToken, verified: false, lastCheckedAt: CheckedAt.toISOString() })
        assert.ok(approvals.StandingOf('t1').approved.includes('gone.com'))
        assert.deepEqual(lines, ['[domain-recheck] 2 domains no longer verified, 0 lookups failed'])
    })

    it('RunOnce leaves a domain verified when its lookup fails', async () =>
    {
        const token = await Verify('t1', 'acme.com')
        resolver.byName.set('_pragmatic-verification.acme.com', { status: TxtLookupStatus.Failed, records: [] })
        const summary = await Rechecker().RunOnce()
        assert.deepEqual(summary, { checked: 1, unverified: 0, failed: 1 })
        assert.deepEqual(approvals.VerificationOf('t1', 'acme.com'), { token, verified: true, lastCheckedAt: OldCheck })
        assert.deepEqual(lines, ['[domain-recheck] 0 domains no longer verified, 1 lookups failed'])
    })

    it('RunOnce checks only verified entries', async () =>
    {
        await Verify('t1', 'yes.com')
        await approvals.EnsureTokens('t1', ['pending.com'])
        await Rechecker().RunOnce()
        assert.deepEqual(resolver.Names, ['_pragmatic-verification.yes.com'])
    })

    it('RunOnce counts a rejected RecordCheck as failed and logs only the error name', async () =>
    {
        const token = await Verify('t1', 'acme.com')
        Publish('acme.com', token)
        const failing = new FailingWriteApprovals(join(dir, 'approvals.json'))
        await failing.Load()
        const summary = await Rechecker(new FakeTimer(), failing).RunOnce()
        assert.deepEqual(summary, { checked: 1, unverified: 0, failed: 1 })
        assert.ok(lines.some(l => l.includes('TypeError')))
        for (const line of lines)
        {
            assert.ok(!line.includes(token) && !line.includes('secret-token') && !line.includes('disk full'))
        }
    })

    it('Start runs once at once and on each tick; a tick during a run is skipped; Stop ends the timer', async () =>
    {
        const token = await Verify('t1', 'acme.com')
        Publish('acme.com', token)
        const counting = new CountingApprovals(join(dir, 'approvals.json'))
        await counting.Load()
        const timer = new FakeTimer()
        let release!: () => void
        resolver.gate = new Promise<void>(resolve => { release = resolve })
        const rechecker = Rechecker(timer, counting)
        rechecker.Start()
        assert.equal(timer.intervalMs, DomainVerificationRechecker.IntervalMs)
        await resolver.entered
        assert.equal(resolver.Names.length, 1)
        timer.Tick()
        await Flush()
        await Flush()
        assert.equal(resolver.Names.length, 1, 'a tick during a run does nothing')
        release()
        await counting.WaitForWrites(1)
        await new Promise(resolve => setImmediate(resolve))
        timer.Tick()
        await counting.WaitForWrites(2)
        assert.equal(resolver.Names.length, 2)
        rechecker.Stop()
        assert.equal(timer.disposed, true)
    })

    it('a throwing log sink is swallowed and RunOnce still resolves', async () =>
    {
        await Verify('t1', 'acme.com')
        const rechecker = new DomainVerificationRechecker(approvals, new DomainTxtVerifier(resolver), new FakeTimer(), () => { throw new Error('sink down') }, () => CheckedAt)
        assert.deepEqual(await rechecker.RunOnce(), { checked: 1, unverified: 1, failed: 0 })
    })

    it('a second Start is a no-op: exactly one timer', async () =>
    {
        const timer = new FakeTimer()
        const rechecker = Rechecker(timer)
        rechecker.Start()
        rechecker.Start()
        assert.equal(timer.timers, 1)
        rechecker.Stop()
    })

    it('the log line carries counts only', async () =>
    {
        const token = await Verify('tenant-one', 'acme.com')
        await Rechecker().RunOnce()
        assert.equal(lines.length, 1)
        assert.ok(!lines[0]!.includes(token) && !lines[0]!.includes('acme.com') && !lines[0]!.includes('tenant-one'))
    })
})
