import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Disposable, Signal, type IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import {
    ConsoleAdvertRefusedError, ConsoleAdvertSender, ConsoleAdvertUnavailableError, HttpConsoleAdvertTransport, SeededConsoleAccounts,
    type IAdvertTimer, type IConsoleAccountSource, type IConsoleAdvertTransport, type IOwnerResetFollower, type IRequestDeadline,
} from '../console-advert-sender.js'
import { ConsoleFingerprint, type ConsoleAdvertAnswer, type ConsoleAdvertBody } from '../console-advert-contract.js'
import { ConsoleEmailDomainStore } from '../console-email-domain-store.js'
import { AdvertTrigger, ConsoleRegistration, ConsoleRegistrationState } from '../console-registration.js'
import { DomainApprovalState, type DomainVerificationAnswer } from '../domain-verification-record.js'
import type { TenantRecord } from '../platform-records.js'
import { DomainNotClaimedError, DomainVerificationUnavailableError, DomainVerifyThrottledError } from '../tenant-api/tenant-email-domains.js'

class Names
{
    public static readonly TempPrefix = 'console-advert-sender-'
    public static readonly TenantId = 'acme'
    public static readonly ConsoleUrl = 'https://console-acme.localtest.me'
    public static readonly OwnerEmail = 'owner@acme.test'
    public static readonly MessyOwnerEmail = ' Owner@Acme.Test '
    public static readonly SecondEmail = 'ann@acme.test'
    public static readonly Domain = 'acme.test'
    public static readonly NewDomain = 'acme-corp.test'
    public static readonly OtherDomain = 'other.test'
    public static readonly ThirdDomain = 'third.test'
    public static readonly Token = 'tok'
    public static readonly SecretToken = 'tok-123'
    public static readonly HiveId = 'acme-hive'
    public static readonly Path = '/agent/hives/acme-hive/console'
    public static readonly Post = 'POST'
    public static readonly Bearer = 'Bearer tok'
    public static readonly SendFailed = 'send failed'
    public static readonly Loopback = '127.0.0.1'
    public static readonly UnreachableMessage = 'The platform agent channel is unreachable'
    public static readonly ConflictMessage = 'The platform agent channel answered HTTP 409'
    public static readonly ConflictBody = '{"error":"leak tok"}'
    public static readonly OkBody = '{"refusedEmailDomains":[]}'
    public static readonly KeyBytes = 32
    public static readonly Conflict = 409
    public static readonly Unauthorized = 401
    public static readonly BadRequest = 400
    public static readonly ServerError = 500
    public static readonly Ok = 200
    public static readonly StatusMessagePrefix = 'The platform agent channel answered HTTP '
    public static readonly RefusedErrorName = 'ConsoleAdvertRefusedError'
    public static readonly RefusedFile = '{"state":"refused"}'
    public static readonly Utf8 = 'utf8'
    public static readonly ClientId = 'c1'
    public static readonly TenantName = 'Acme'
    public static readonly Created = '2026-01-01T00:00:00Z'
    public static readonly JsonType = 'application/json'
    public static readonly ContentTypeHeader = 'Content-Type'
    public static readonly TestTimeoutMs = 5000
    public static readonly AbortedMessage = 'aborted'
    public static readonly AbortEvent = 'abort'
    public static readonly SendFailedPrefix = '[console-advert] send failed: '
    public static readonly OwnerResetFailedPrefix = '[console-advert] owner reset not applied: '
    public static readonly ResetAt = '2026-11-04T10:00:00.000Z'
    public static readonly MaxDomains = 20
    public static readonly MaxDomainLength = 253
    public static readonly VerifyPath = '/agent/hives/acme-hive/console/verify-domain'
    public static readonly VerifyToken = 'A'.repeat(43)
    public static readonly CheckedAt = '2026-11-06T10:00:00.000Z'
    public static readonly TooManyRequests = 429
    public static readonly Unavailable = 503
    public static readonly LeakBody = '{"error":"server text leak tok-123"}'
    public static readonly LeakText = 'leak'
    public static readonly UnknownField = 'dropped'
    public static readonly NotListedMessage = 'The platform does not list acme.test for this console yet. Try again after the console reports its domains.'
    public static readonly ThrottledMessage = 'Too many verification attempts. Try again in a few minutes.'
    public static readonly PlatformUnavailableMessage = 'The platform could not check the domain. Try again later.'
}

/** Verification answers shaped as the platform sends them. */
class Verifications
{
    public static Of(domain: string, state: DomainApprovalState = DomainApprovalState.Pending): DomainVerificationAnswer
    {
        return { domain, token: Names.VerifyToken, verified: false, state, lastCheckedAt: Names.CheckedAt }
    }

    /** A distinct domain of exactly 253 characters (four labels within 63, a non-numeric top label). */
    public static MaximalDomain(i: number): string
    {
        const domain = String(i).padStart(2, '0') + 'a'.repeat(61) + '.' + 'b'.repeat(63) + '.' + 'c'.repeat(63) + '.' + 'd'.repeat(57) + '.com'
        assert.equal(domain.length, Names.MaxDomainLength)
        return domain
    }
}

class RecordingTransport implements IConsoleAdvertTransport
{
    public readonly bodies: ConsoleAdvertBody[] = []
    public readonly signals: Array<AbortSignal | undefined> = []
    public failWith: Error | undefined
    private gate: Promise<void> | undefined
    private open: (() => void) | undefined

    public Hold(): void
    {
        this.gate = new Promise<void>(res => { this.open = res })
    }

    public Release(): void
    {
        this.gate = undefined
        this.open?.()
    }

    public answer: ConsoleAdvertAnswer = {}

    public async Send(body: ConsoleAdvertBody, signal?: AbortSignal): Promise<ConsoleAdvertAnswer>
    {
        this.bodies.push(body)
        this.signals.push(signal)
        if (this.gate !== undefined)
        {
            const aborted = new Promise<void>((_res, rej) => signal?.addEventListener(Names.AbortEvent, () => rej(new Error(Names.AbortedMessage)), { once: true }))
            await Promise.race([this.gate, aborted])
        }
        if (this.failWith !== undefined)
        {
            throw this.failWith
        }
        return this.answer
    }
}

/** Records every value handed to it; can be made to throw. */
class FakeFollower implements IOwnerResetFollower
{
    public readonly applied: Array<string | undefined> = []
    public failWith: Error | undefined

    public async Apply(resetAt: string | undefined): Promise<boolean>
    {
        this.applied.push(resetAt)
        if (this.failWith !== undefined)
        {
            throw this.failWith
        }
        return resetAt !== undefined
    }
}

class FakeTimer implements IAdvertTimer
{
    public intervalMs = 0
    public disposed = false
    private tick: (() => void) | undefined

    public Every(intervalMs: number, tick: () => void): IDisposable
    {
        this.intervalMs = intervalMs
        this.tick = tick
        return new Disposable(() => { this.disposed = true })
    }

    public Tick(): void
    {
        this.tick?.()
    }
}

/** A request deadline the test expires by hand: no wall-clock wait decides when a send times out. */
class FakeDeadline implements IRequestDeadline
{
    public readonly Requested: number[] = []
    private readonly issued: AbortController[] = []

    public SignalAfter(timeoutMs: number): AbortSignal
    {
        this.Requested.push(timeoutMs)
        const controller = new AbortController()
        this.issued.push(controller)
        return controller.signal
    }

    /** Times out every send issued so far (later sends get a fresh, live deadline). */
    public Expire(): void
    {
        for (const controller of this.issued)
        {
            controller.abort()
        }
    }
}

/** A promise resolved by hand, for "the request has reached the server". */
class Arrival
{
    public readonly Reached: Promise<void>
    private resolve: () => void = () => undefined

    public constructor()
    {
        this.Reached = new Promise<void>(r => { this.resolve = r })
    }

    public Mark(): void
    {
        this.resolve()
    }
}

class FakeAccounts implements IConsoleAccountSource
{
    public readonly Changed = new Signal<void>()

    public constructor(public emails: string[])
    {
    }

    public Emails(): readonly string[]
    {
        return this.emails
    }
}

class Waits
{
    /** Lets queued promise continuations (a send's settle and the next loop turn) run. */
    public static async Settle(): Promise<void>
    {
        for (let i = 0; i < 10; i++)
        {
            await new Promise<void>(res => setImmediate(res))
        }
    }
}

describe('ConsoleAdvertSender', () =>
{
    const key = randomBytes(Names.KeyBytes)
    let root = ''
    let store: ConsoleEmailDomainStore
    let transport: RecordingTransport
    let timer: FakeTimer
    let accounts: FakeAccounts
    let lines: string[]

    const sender = (): ConsoleAdvertSender => new ConsoleAdvertSender(transport, accounts, store, key, Names.ConsoleUrl, timer, line => lines.push(line))

    beforeEach(async () =>
    {
        root = mkdtempSync(join(tmpdir(), Names.TempPrefix))
        store = await ConsoleEmailDomainStore.Open(join(root, ConsoleEmailDomainStore.FileName), Names.TenantId, [Names.Domain])
        transport = new RecordingTransport()
        timer = new FakeTimer()
        accounts = new FakeAccounts([Names.OwnerEmail])
        lines = []
    })

    afterEach(() =>
    {
        rmSync(root, { recursive: true, force: true })
    })

    it('Start sends at once, then every five minutes', async () =>
    {
        const s = sender()
        await s.Start()
        assert.equal(transport.bodies.length, 1)
        assert.equal(timer.intervalMs, 300000)
        assert.equal(ConsoleAdvertSender.IntervalMs, 300000)
        timer.Tick()
        await Waits.Settle()
        assert.equal(transport.bodies.length, 2)
        s.Stop()
    })

    it('the body carries the console URL, the Owner fingerprint and the domains', async () =>
    {
        const s = sender()
        await s.Start()
        assert.deepEqual(transport.bodies[0], {
            consoleUrl: Names.ConsoleUrl,
            fingerprints: [ConsoleFingerprint.Of(key, Names.OwnerEmail)],
            emailDomains: [Names.Domain],
        })
        s.Stop()
    })

    it('fingerprints are sorted and unique', () =>
    {
        accounts.emails = [Names.SecondEmail, Names.OwnerEmail, Names.OwnerEmail.toUpperCase()]
        const expected = [ConsoleFingerprint.Of(key, Names.SecondEmail), ConsoleFingerprint.Of(key, Names.OwnerEmail)].sort()
        assert.deepEqual(sender().Body().fingerprints, expected)
    })

    it('the Owner fingerprint is of the trimmed, lower-cased email', () =>
    {
        const tenant: TenantRecord = { id: Names.TenantId, clientId: Names.ClientId, displayName: Names.TenantName, createdAt: Names.Created, ownerEmail: Names.MessyOwnerEmail }
        const s = new ConsoleAdvertSender(transport, new SeededConsoleAccounts(tenant), store, key, Names.ConsoleUrl, timer, line => lines.push(line))
        assert.deepEqual(s.Body().fingerprints, [ConsoleFingerprint.Of(key, Names.OwnerEmail)])
    })

    it('a seed without an Owner email advertises no fingerprints', () =>
    {
        const tenant: TenantRecord = { id: Names.TenantId, clientId: Names.ClientId, displayName: Names.TenantName, createdAt: Names.Created }
        assert.deepEqual(new SeededConsoleAccounts(tenant).Emails(), [])
    })

    it('a domain change is sent immediately', async () =>
    {
        const s = sender()
        await s.Start()
        await store.Set(Names.TenantId, [Names.NewDomain])
        await Waits.Settle()
        assert.equal(transport.bodies.length, 2)
        assert.deepEqual(transport.bodies[1].emailDomains, [Names.NewDomain])
        s.Stop()
    })

    it('an account change is sent immediately', async () =>
    {
        const s = sender()
        await s.Start()
        accounts.emails = [Names.OwnerEmail, Names.SecondEmail]
        accounts.Changed.emit()
        await Waits.Settle()
        assert.equal(transport.bodies.length, 2)
        assert.equal(transport.bodies[1].fingerprints.length, 2)
        s.Stop()
    })

    it('changes during a send are coalesced into one more send', async () =>
    {
        const s = sender()
        await s.Start()
        transport.Hold()
        timer.Tick()
        await Waits.Settle()
        assert.equal(transport.bodies.length, 2, 'the held send is in flight')
        await store.Set(Names.TenantId, [Names.NewDomain])
        await store.Set(Names.TenantId, [Names.OtherDomain])
        accounts.Changed.emit()
        await Waits.Settle()
        assert.equal(transport.bodies.length, 2, 'nothing more while a send is in flight')
        transport.Release()
        await Waits.Settle()
        assert.equal(transport.bodies.length, 3, 'exactly one more send after the held one')
        assert.deepEqual(transport.bodies[2].emailDomains, [Names.OtherDomain], 'the queued send carries the latest state')
        s.Stop()
    })

    it('SendNow during a send resolves after the queued send', async () =>
    {
        const s = sender()
        transport.Hold()
        const first = s.SendNow()
        const second = s.SendNow()
        transport.Release()
        await Promise.all([first, second])
        assert.equal(transport.bodies.length, 2)
    })

    it('a failed send is logged by name only and retried on the next tick', async () =>
    {
        const s = sender()
        transport.failWith = new Error('token ' + Names.SecretToken + ' ' + Names.OwnerEmail)
        await s.Start()
        await store.Set(Names.TenantId, [Names.NewDomain])
        await Waits.Settle()
        assert.equal(transport.bodies.length, 2)
        assert.ok(lines.length >= 2)
        for (const line of lines)
        {
            assert.ok(line.includes(Names.SendFailed), line)
            assert.ok(!line.includes(Names.SecretToken), 'never the token')
            assert.ok(!line.includes(Names.OwnerEmail), 'never an email')
        }
        transport.failWith = undefined
        timer.Tick()
        await Waits.Settle()
        assert.equal(transport.bodies.length, 3)
        s.Stop()
    })

    it('an unavailable channel logs its fixed sentence with the status', async () =>
    {
        const s = sender()
        transport.failWith = new ConsoleAdvertUnavailableError(Names.ConflictMessage)
        await s.Start()
        assert.deepEqual(lines, [Names.SendFailedPrefix + Names.ConflictMessage])
        s.Stop()
    })

    it('Stop ends the timer and the subscriptions', async () =>
    {
        const s = sender()
        await s.Start()
        s.Stop()
        assert.equal(timer.disposed, true)
        await store.Set(Names.TenantId, [Names.NewDomain])
        accounts.Changed.emit()
        await Waits.Settle()
        assert.equal(transport.bodies.length, 1)
        assert.equal(store.Changed.subscriberCount, 0)
        assert.equal(accounts.Changed.subscriberCount, 0)
    })

    it('Stop during a send drops the queued send', async () =>
    {
        const s = sender()
        await s.Start()
        transport.Hold()
        timer.Tick()
        await Waits.Settle()
        await store.Set(Names.TenantId, [Names.NewDomain])
        s.Stop()
        transport.Release()
        await Waits.Settle()
        assert.equal(transport.bodies.length, 2)
    })

    it('Stop aborts the send in flight, Idle settles and nothing is logged late', async () =>
    {
        const s = sender()
        await s.Start()
        transport.Hold()
        timer.Tick()
        await Waits.Settle()
        const signal = transport.signals[1]
        assert.ok(signal !== undefined, 'every send carries an abort signal')
        assert.equal(signal.aborted, false)
        s.Stop()
        assert.equal(signal.aborted, true)
        await s.Idle()
        await Waits.Settle()
        assert.deepEqual(lines, [], 'an aborted send after Stop is not a failure to report')
        transport.Release()
    })

    it('Idle is settled when nothing is in flight', async () =>
    {
        await sender().Idle()
    })

    it('a 200 advert answer is handed to the owner-reset follower', async () =>
    {
        const follower = new FakeFollower()
        const s = new ConsoleAdvertSender(transport, accounts, store, key, Names.ConsoleUrl, timer, line => lines.push(line), follower)
        await s.Start()
        transport.answer = { ownerResetAt: Names.ResetAt }
        timer.Tick()
        await s.Idle()
        assert.deepEqual(follower.applied, [undefined, Names.ResetAt], 'every 200 answer, with or without a reset')
        transport.failWith = new Error(Names.SendFailed)
        timer.Tick()
        await s.Idle()
        assert.equal(follower.applied.length, 2, 'a failed send hands nothing over')
        s.Stop()
    })

    it('an answer that arrives after Stop is not handed to the follower', async () =>
    {
        const follower = new FakeFollower()
        let s: ConsoleAdvertSender | undefined
        const stopping: IConsoleAdvertTransport = { Send: async () => { s?.Stop(); return { ownerResetAt: Names.ResetAt } } }
        s = new ConsoleAdvertSender(stopping, accounts, store, key, Names.ConsoleUrl, timer, line => lines.push(line), follower)
        await s.SendNow()
        assert.deepEqual(follower.applied, [])
        assert.deepEqual(lines, [])
    })

    it('a follower that fails after Stop logs nothing', async () =>
    {
        let release: () => void = () => undefined
        const follower: IOwnerResetFollower = {
            Apply: async () =>
            {
                await new Promise<void>(res => { release = res })
                throw new TypeError(Names.SendFailed)
            },
        }
        transport.answer = { ownerResetAt: Names.ResetAt }
        const s = new ConsoleAdvertSender(transport, accounts, store, key, Names.ConsoleUrl, timer, line => lines.push(line), follower)
        const sending = s.SendNow()
        await Waits.Settle()
        s.Stop()
        release()
        await sending
        await s.Idle()
        assert.deepEqual(lines, [])
    })

    it('a throwing follower is logged by error name only and never fails the advert', async () =>
    {
        const follower = new FakeFollower()
        follower.failWith = new TypeError('store at /data/owner ' + Names.OwnerEmail)
        transport.answer = { ownerResetAt: Names.ResetAt }
        const s = new ConsoleAdvertSender(transport, accounts, store, key, Names.ConsoleUrl, timer, line => lines.push(line), follower)
        await s.Start()
        assert.deepEqual(lines, [Names.OwnerResetFailedPrefix + 'TypeError'])
        timer.Tick()
        await s.Idle()
        assert.equal(transport.bodies.length, 2, 'the advert keeps running')
        assert.equal(follower.applied.length, 2, 'the next answer is handed over again')
        s.Stop()
    })

    it('the sender hands a 200 answer\'s verifications to the store', async () =>
    {
        const s = sender()
        transport.answer = { domainVerifications: [Verifications.Of(Names.Domain, DomainApprovalState.VerifiedContested)] }
        await s.Start()
        const view = await store.For(Names.TenantId)
        assert.deepEqual(view.verifications.map(v => [v.domain, v.state]), [[Names.Domain, DomainApprovalState.VerifiedContested]])
        assert.deepEqual(view.pending, [Names.Domain])
        transport.failWith = new Error(Names.SendFailed)
        timer.Tick()
        await s.Idle()
        assert.equal((await store.For(Names.TenantId)).verifications.length, 1, 'a failed send keeps what was adopted')
        transport.failWith = undefined
        transport.answer = {}
        timer.Tick()
        await s.Idle()
        assert.deepEqual((await store.For(Names.TenantId)).verifications, [], 'an answer without verifications adopts none')
        s.Stop()
    })

    it('an answer that arrives after Stop is not adopted', async () =>
    {
        let s: ConsoleAdvertSender | undefined
        const stopping: IConsoleAdvertTransport = { Send: async () => { s?.Stop(); return { domainVerifications: [Verifications.Of(Names.Domain)] } } }
        s = new ConsoleAdvertSender(stopping, accounts, store, key, Names.ConsoleUrl, timer, line => lines.push(line))
        await s.SendNow()
        assert.deepEqual((await store.For(Names.TenantId)).verifications, [])
    })

    describe('registration', () =>
    {
        let registration: ConsoleRegistration

        const registered = (): ConsoleAdvertSender =>
            new ConsoleAdvertSender(transport, accounts, store, key, Names.ConsoleUrl, timer, line => lines.push(line), undefined, registration)

        beforeEach(async () =>
        {
            registration = await ConsoleRegistration.Open(join(root, ConsoleRegistration.FileName))
        })

        it('two refused timer ticks make the registration Refused; refused change sends do not', async () =>
        {
            transport.failWith = new ConsoleAdvertRefusedError(Names.Conflict)
            const s = registered()
            await s.Start()
            await store.Set(Names.TenantId, [Names.NewDomain])
            await s.Idle()
            await store.Set(Names.TenantId, [Names.OtherDomain])
            await s.Idle()
            assert.equal(transport.bodies.length, 3)
            assert.equal(registration.State, ConsoleRegistrationState.Registered, 'start and change refusals do not count')
            timer.Tick()
            await s.Idle()
            assert.equal(registration.State, ConsoleRegistrationState.Registered, 'one timer refusal is not enough')
            timer.Tick()
            await s.Idle()
            assert.equal(registration.State, ConsoleRegistrationState.Refused)
            assert.deepEqual(lines.slice(-1), [Names.SendFailedPrefix + Names.ConflictMessage], 'a refusal logs the same sentence as before')
            s.Stop()
        })

        it('a 200 from any send restores Registered', async () =>
        {
            writeFileSync(join(root, ConsoleRegistration.FileName), Names.RefusedFile, Names.Utf8)
            registration = await ConsoleRegistration.Open(join(root, ConsoleRegistration.FileName))
            assert.equal(registration.State, ConsoleRegistrationState.Refused)
            transport.failWith = new ConsoleAdvertRefusedError(Names.Unauthorized)
            const s = registered()
            await s.Start()
            assert.equal(registration.State, ConsoleRegistrationState.Refused)
            transport.failWith = undefined
            await store.Set(Names.TenantId, [Names.NewDomain])
            await s.Idle()
            assert.equal(registration.State, ConsoleRegistrationState.Registered, 'a change-triggered 200 restores it')
            s.Stop()
        })

        it('the first send at startup restores Registered on a 200 but a refusal there does not count', async () =>
        {
            writeFileSync(join(root, ConsoleRegistration.FileName), Names.RefusedFile, Names.Utf8)
            registration = await ConsoleRegistration.Open(join(root, ConsoleRegistration.FileName))
            const s = registered()
            await s.Start()
            assert.equal(registration.State, ConsoleRegistrationState.Registered)
            s.Stop()
        })

        it('a transient timer answer between two refused timer ticks keeps it Registered', async () =>
        {
            const s = registered()
            await s.Start()
            transport.failWith = new ConsoleAdvertRefusedError(Names.Conflict)
            timer.Tick()
            await s.Idle()
            transport.failWith = new ConsoleAdvertUnavailableError(Names.UnreachableMessage)
            timer.Tick()
            await s.Idle()
            transport.failWith = new ConsoleAdvertRefusedError(Names.Conflict)
            timer.Tick()
            await s.Idle()
            assert.equal(registration.State, ConsoleRegistrationState.Registered)
            s.Stop()
        })

        it('a timer tick queued behind a change send counts as a timer send', async () =>
        {
            const s = registered()
            await s.Start()
            transport.failWith = new ConsoleAdvertRefusedError(Names.Conflict)
            transport.Hold()
            await store.Set(Names.TenantId, [Names.NewDomain])
            await Waits.Settle()
            assert.equal(transport.bodies.length, 2, 'the change send is in flight')
            timer.Tick()
            timer.Tick()
            transport.Release()
            await s.Idle()
            assert.equal(transport.bodies.length, 3, 'the two ticks merged into one send')
            assert.equal(registration.State, ConsoleRegistrationState.Registered, 'the streak is 1')
            timer.Tick()
            await s.Idle()
            assert.equal(registration.State, ConsoleRegistrationState.Refused, 'the merged send counted, so this tick is the second')
            s.Stop()
        })

        it('a change queued behind a change send does not count', async () =>
        {
            const s = registered()
            await s.Start()
            transport.failWith = new ConsoleAdvertRefusedError(Names.Conflict)
            timer.Tick()
            await s.Idle()
            transport.Hold()
            await store.Set(Names.TenantId, [Names.NewDomain])
            await Waits.Settle()
            await store.Set(Names.TenantId, [Names.OtherDomain])
            transport.Release()
            await s.Idle()
            assert.equal(transport.bodies.length, 4)
            assert.equal(registration.State, ConsoleRegistrationState.Registered, 'the queued send was a change send')
            timer.Tick()
            await s.Idle()
            assert.equal(registration.State, ConsoleRegistrationState.Refused, 'the change sends did not break the streak')
            s.Stop()
        })

        it('no outcome is observed after Stop', async () =>
        {
            let s: ConsoleAdvertSender | undefined
            let stopOnSend = false
            const refusing: IConsoleAdvertTransport = {
                Send: async () =>
                {
                    if (stopOnSend)
                    {
                        s?.Stop()
                    }
                    throw new ConsoleAdvertRefusedError(Names.Conflict)
                },
            }
            s = new ConsoleAdvertSender(refusing, accounts, store, key, Names.ConsoleUrl, timer, line => lines.push(line), undefined, registration)
            const seen: ConsoleRegistrationState[] = []
            registration.Changed.subscribe(v => seen.push(v))
            await s.SendNow(AdvertTrigger.Timer)
            stopOnSend = true
            await s.SendNow(AdvertTrigger.Timer)
            assert.equal(registration.State, ConsoleRegistrationState.Registered, 'the refusal after Stop was not observed')
            assert.deepEqual(seen, [])

            writeFileSync(join(root, ConsoleRegistration.FileName), Names.RefusedFile, Names.Utf8)
            registration = await ConsoleRegistration.Open(join(root, ConsoleRegistration.FileName))
            const accepting: IConsoleAdvertTransport = { Send: async () => { s?.Stop(); return {} } }
            s = new ConsoleAdvertSender(accepting, accounts, store, key, Names.ConsoleUrl, timer, line => lines.push(line), undefined, registration)
            await s.SendNow(AdvertTrigger.Timer)
            assert.equal(registration.State, ConsoleRegistrationState.Refused, 'the 200 after Stop was not observed')
        })
    })
})

describe('HttpConsoleAdvertTransport', () =>
{
    let server: Server | undefined

    afterEach(async () =>
    {
        const s = server
        server = undefined
        if (s !== undefined)
        {
            s.closeAllConnections()
            await new Promise<void>(res => s.close(() => res()))
        }
    })

    /** A handler answering undefined never answers (a hung control plane). */
    const listen = async (handler: (req: IncomingMessage, body: string) => { status: number; body: string } | undefined): Promise<string> =>
    {
        server = createServer((req, res) =>
        {
            const chunks: Buffer[] = []
            req.on('data', (c: Buffer) => chunks.push(c))
            req.on('end', () =>
            {
                const answer = handler(req, Buffer.concat(chunks).toString())
                if (answer === undefined)
                {
                    return
                }
                res.writeHead(answer.status, { [Names.ContentTypeHeader]: Names.JsonType })
                res.end(answer.body)
            })
        })
        await new Promise<void>(res => server!.listen(0, Names.Loopback, () => res()))
        return `http://${Names.Loopback}:${(server!.address() as AddressInfo).port}`
    }

    const body: ConsoleAdvertBody = { consoleUrl: Names.ConsoleUrl, fingerprints: [], emailDomains: [Names.Domain] }

    it('posts the advert with the bearer', async () =>
    {
        let seen: { method?: string; url?: string; authorization?: string; contentType?: string; body?: unknown } = {}
        const url = await listen((req, text) =>
        {
            seen = { method: req.method, url: req.url, authorization: req.headers.authorization, contentType: req.headers['content-type'], body: JSON.parse(text) }
            return { status: Names.Ok, body: Names.OkBody }
        })
        await new HttpConsoleAdvertTransport(url, Names.Token, Names.HiveId).Send(body)
        assert.equal(seen.method, Names.Post)
        assert.equal(seen.url, Names.Path)
        assert.equal(seen.authorization, Names.Bearer)
        assert.equal(seen.contentType, Names.JsonType)
        assert.deepEqual(seen.body, body)
    })

    it('a 200 answer yields its ownerResetAt', async () =>
    {
        const url = await listen(() => ({ status: Names.Ok, body: JSON.stringify({ refusedEmailDomains: [], ownerResetAt: Names.ResetAt }) }))
        assert.deepEqual(await new HttpConsoleAdvertTransport(url, Names.Token, Names.HiveId).Send(body), { ownerResetAt: Names.ResetAt })
    })

    it('a maximal legitimate answer (20 refused 253-character domains) still yields its ownerResetAt', async () =>
    {
        const refused = Array.from({ length: Names.MaxDomains }, (_v, i) => String(i).padStart(2, '0') + 'a'.repeat(Names.MaxDomainLength - 6) + '.com')
        const answer = JSON.stringify({ refusedEmailDomains: refused, ownerResetAt: Names.ResetAt })
        assert.ok(answer.length > 5000, 'the answer is larger than the old 4096-byte cap')
        const url = await listen(() => ({ status: Names.Ok, body: answer }))
        assert.deepEqual(await new HttpConsoleAdvertTransport(url, Names.Token, Names.HiveId).Send(body), { ownerResetAt: Names.ResetAt })
    })

    it('a 200 answer without a reset, or a malformed, non-time or oversized one, yields nothing', async () =>
    {
        const answers = [
            Names.OkBody,
            '{not json',
            'null',
            '[]',
            JSON.stringify({ ownerResetAt: 5 }),
            JSON.stringify({ ownerResetAt: 'not a time' }),
            JSON.stringify({ ownerResetAt: Names.ResetAt, padding: 'x'.repeat(HttpConsoleAdvertTransport.MaxAnswerBytes) }),
        ]
        let next = 0
        const url = await listen(() => ({ status: Names.Ok, body: answers[next++] }))
        for (const answer of answers)
        {
            assert.deepEqual(await new HttpConsoleAdvertTransport(url, Names.Token, Names.HiveId).Send(body), {}, answer.slice(0, 40))
        }
    })

    it('AnswerOf keeps well-formed domainVerifications and drops malformed entries', async () =>
    {
        const good = Verifications.Of(Names.Domain)
        const unchecked: DomainVerificationAnswer = { domain: Names.OtherDomain, token: Names.VerifyToken, verified: true, state: DomainApprovalState.Approved }
        const entries: unknown[] = [
            good,
            { ...good, token: 'short' },
            { ...good, state: 'unknown' },
            { ...good, domain: 'not a domain' },
            { ...good, verified: 'yes' },
            { ...good, lastCheckedAt: 'not a time' },
            'acme.test',
            null,
            { ...unchecked, extra: Names.UnknownField },
        ]
        const many = Array.from({ length: Names.MaxDomains + 5 }, (_v, i) => Verifications.Of('d' + i + '.test'))
        const answers = [
            JSON.stringify({ ownerResetAt: Names.ResetAt, domainVerifications: entries }),
            JSON.stringify({ domainVerifications: many }),
            JSON.stringify({ domainVerifications: { [Names.Domain]: good } }),
            JSON.stringify({ domainVerifications: [] }),
        ]
        let next = 0
        const url = await listen(() => ({ status: Names.Ok, body: answers[next++] }))
        const transport = new HttpConsoleAdvertTransport(url, Names.Token, Names.HiveId)
        assert.deepEqual(await transport.Send(body), { ownerResetAt: Names.ResetAt, domainVerifications: [good, unchecked] })
        assert.deepEqual(await transport.Send(body), { domainVerifications: many.slice(0, Names.MaxDomains) }, 'at most MaxDomains are kept')
        assert.deepEqual(await transport.Send(body), {}, 'a non-array is not taken')
        assert.deepEqual(await transport.Send(body), { domainVerifications: [] })
    })

    it('an answer of 20 maximal verifications fits MaxAnswerBytes and AnswerOf keeps all 20', async () =>
    {
        const maximal = Array.from({ length: Names.MaxDomains }, (_v, i) => Verifications.Of(Verifications.MaximalDomain(i), DomainApprovalState.VerifiedContested))
        const answer = JSON.stringify({ refusedEmailDomains: [], ownerResetAt: Names.ResetAt, domainVerifications: maximal })
        assert.ok(Buffer.byteLength(answer) <= HttpConsoleAdvertTransport.MaxAnswerBytes, String(Buffer.byteLength(answer)))
        const url = await listen(() => ({ status: Names.Ok, body: answer }))
        const taken = await new HttpConsoleAdvertTransport(url, Names.Token, Names.HiveId).Send(body)
        assert.equal(taken.domainVerifications?.length, Names.MaxDomains)
        assert.deepEqual(taken, { ownerResetAt: Names.ResetAt, domainVerifications: maximal })
    })

    it('VerifyDomain posts only { domain } with the bearer to the verify-domain path', async () =>
    {
        let seen: { method?: string; url?: string; authorization?: string; contentType?: string; body?: unknown } = {}
        const verification = Verifications.Of(Names.Domain, DomainApprovalState.Verified)
        const url = await listen((req, text) =>
        {
            seen = { method: req.method, url: req.url, authorization: req.headers.authorization, contentType: req.headers['content-type'], body: JSON.parse(text) }
            return { status: Names.Ok, body: JSON.stringify({ verification: { ...verification, extra: Names.UnknownField } }) }
        })
        const deadline = new FakeDeadline()
        const answer = await new HttpConsoleAdvertTransport(url, Names.Token, Names.HiveId, HttpConsoleAdvertTransport.RequestTimeoutMs, deadline).VerifyDomain(Names.Domain)
        assert.deepEqual(answer, verification)
        assert.equal(seen.method, Names.Post)
        assert.equal(seen.url, Names.VerifyPath)
        assert.equal(seen.authorization, Names.Bearer)
        assert.equal(seen.contentType, Names.JsonType)
        assert.deepEqual(seen.body, { domain: Names.Domain })
        assert.deepEqual(deadline.Requested, [HttpConsoleAdvertTransport.RequestTimeoutMs], 'the same request timeout as the advert')
    })

    it('VerifyDomain maps 409, 429, 503, unreachable and malformed 200 to the fixed sentences', { timeout: Names.TestTimeoutMs }, async () =>
    {
        let answer: { status: number; body: string } | undefined
        const url = await listen(() => answer)
        const transport = new HttpConsoleAdvertTransport(url, Names.Token, Names.HiveId)
        const expect = async (kind: new (message: string) => Error, message: string, label: string): Promise<void> =>
        {
            await assert.rejects(() => transport.VerifyDomain(Names.Domain), (err: unknown) =>
            {
                assert.ok(err instanceof kind, label)
                assert.equal((err as Error).message, message, label)
                assert.ok(!(err as Error).message.includes(Names.LeakText), label + ': never the server text')
                assert.ok(!(err as Error).message.includes(Names.SecretToken), label + ': never the token')
                assert.ok(!(err instanceof ConsoleAdvertUnavailableError), label + ': never an advert error, so never a registration outcome')
                return true
            })
        }
        answer = { status: Names.Conflict, body: Names.LeakBody }
        await expect(DomainNotClaimedError, Names.NotListedMessage, '409')
        answer = { status: Names.TooManyRequests, body: Names.LeakBody }
        await expect(DomainVerifyThrottledError, Names.ThrottledMessage, '429')
        for (const status of [Names.Unavailable, Names.BadRequest, Names.Unauthorized, Names.ServerError])
        {
            answer = { status, body: Names.LeakBody }
            await expect(DomainVerificationUnavailableError, Names.PlatformUnavailableMessage, String(status))
        }
        const malformed = [
            Names.LeakBody,
            '{not json',
            JSON.stringify({ verification: { ...Verifications.Of(Names.Domain), token: Names.LeakText } }),
            JSON.stringify({ verification: Verifications.Of(Names.Domain), padding: 'x'.repeat(HttpConsoleAdvertTransport.MaxAnswerBytes) }),
        ]
        for (const text of malformed)
        {
            answer = { status: Names.Ok, body: text }
            await expect(DomainVerificationUnavailableError, Names.PlatformUnavailableMessage, 'malformed 200 ' + text.slice(0, 30))
        }
        const s = server!
        server = undefined
        s.closeAllConnections()
        await new Promise<void>(res => s.close(() => res()))
        await expect(DomainVerificationUnavailableError, Names.PlatformUnavailableMessage, 'unreachable')
    })

    it('VerifyDomain that outlives its deadline is the unavailable sentence', { timeout: Names.TestTimeoutMs }, async () =>
    {
        const arrival = new Arrival()
        const url = await listen(() =>
        {
            arrival.Mark()
            return undefined
        })
        const deadline = new FakeDeadline()
        const verifying = new HttpConsoleAdvertTransport(url, Names.Token, Names.HiveId, HttpConsoleAdvertTransport.RequestTimeoutMs, deadline).VerifyDomain(Names.Domain)
        await arrival.Reached
        deadline.Expire()
        await assert.rejects(() => verifying, (err: unknown) => err instanceof DomainVerificationUnavailableError && err.message === Names.PlatformUnavailableMessage)
    })

    it('a 409 is ConsoleAdvertUnavailableError without the token', async () =>
    {
        const url = await listen(() => ({ status: Names.Conflict, body: Names.ConflictBody }))
        await assert.rejects(() => new HttpConsoleAdvertTransport(url, Names.Token, Names.HiveId).Send(body), (err: unknown) =>
        {
            assert.ok(err instanceof ConsoleAdvertUnavailableError)
            assert.equal(err.message, Names.ConflictMessage)
            assert.ok(!err.message.includes(Names.Token))
            return true
        })
    })

    it('401 and 409 are refusals; 400 and 500 are not', async () =>
    {
        let status: number = Names.Ok
        const url = await listen(() => ({ status, body: Names.ConflictBody }))
        const transport = new HttpConsoleAdvertTransport(url, Names.Token, Names.HiveId)
        for (const refused of [Names.Unauthorized, Names.Conflict])
        {
            status = refused
            await assert.rejects(() => transport.Send(body), (err: unknown) =>
            {
                assert.ok(err instanceof ConsoleAdvertRefusedError, String(refused))
                assert.ok(err instanceof ConsoleAdvertUnavailableError, 'a refusal is still an unavailable channel')
                assert.equal(err.Status, refused)
                assert.equal(err.name, Names.RefusedErrorName)
                assert.equal(err.message, Names.StatusMessagePrefix + refused)
                return true
            })
        }
        for (const transient of [Names.BadRequest, Names.ServerError])
        {
            status = transient
            await assert.rejects(() => transport.Send(body), (err: unknown) =>
            {
                assert.ok(err instanceof ConsoleAdvertUnavailableError, String(transient))
                assert.ok(!(err instanceof ConsoleAdvertRefusedError), String(transient))
                assert.equal(err.message, Names.StatusMessagePrefix + transient)
                return true
            })
        }
    })

    it('an unreachable channel is the fixed sentence', async () =>
    {
        const url = await listen(() => ({ status: Names.Ok, body: Names.OkBody }))
        const s = server!
        server = undefined
        await new Promise<void>(res => s.close(() => res()))
        await assert.rejects(() => new HttpConsoleAdvertTransport(url, Names.Token, Names.HiveId).Send(body), (err: unknown) =>
        {
            assert.ok(err instanceof ConsoleAdvertUnavailableError)
            assert.equal(err.message, Names.UnreachableMessage)
            return true
        })
    })

    it('a channel that never answers times out as the unreachable sentence', { timeout: Names.TestTimeoutMs }, async () =>
    {
        const arrival = new Arrival()
        const url = await listen(() =>
        {
            arrival.Mark()
            return undefined
        })
        const deadline = new FakeDeadline()
        const sending = new HttpConsoleAdvertTransport(url, Names.Token, Names.HiveId, HttpConsoleAdvertTransport.RequestTimeoutMs, deadline).Send(body)
        await arrival.Reached
        deadline.Expire()
        await assert.rejects(() => sending, (err: unknown) =>
        {
            assert.ok(err instanceof ConsoleAdvertUnavailableError)
            assert.equal(err.message, Names.UnreachableMessage)
            return true
        })
        assert.deepEqual(deadline.Requested, [HttpConsoleAdvertTransport.RequestTimeoutMs])
    })

    it('an aborted send is the unreachable sentence', { timeout: Names.TestTimeoutMs }, async () =>
    {
        const url = await listen(() => undefined)
        const abort = new AbortController()
        const sending = new HttpConsoleAdvertTransport(url, Names.Token, Names.HiveId).Send(body, abort.signal)
        abort.abort()
        await assert.rejects(() => sending, ConsoleAdvertUnavailableError)
    })

    it('a real 400 or 500 answer on a timer tick between two refused ticks is transient and keeps it Registered', async () =>
    {
        let statuses: number[] = []
        const url = await listen(() => ({ status: statuses.shift() ?? Names.Ok, body: Names.ConflictBody }))
        const root = mkdtempSync(join(tmpdir(), Names.TempPrefix))
        try
        {
            const store = await ConsoleEmailDomainStore.Open(join(root, ConsoleEmailDomainStore.FileName), Names.TenantId, [Names.Domain])
            const timed = async (answers: number[]): Promise<ConsoleRegistrationState> =>
            {
                rmSync(join(root, ConsoleRegistration.FileName), { force: true })
                const registration = await ConsoleRegistration.Open(join(root, ConsoleRegistration.FileName))
                const s = new ConsoleAdvertSender(new HttpConsoleAdvertTransport(url, Names.Token, Names.HiveId), new FakeAccounts([Names.OwnerEmail]),
                    store, randomBytes(Names.KeyBytes), Names.ConsoleUrl, new FakeTimer(), () => undefined, undefined, registration)
                statuses = [...answers]
                for (let i = 0; i < answers.length; i++)
                {
                    await s.SendNow(AdvertTrigger.Timer)
                }
                return registration.State
            }
            assert.equal(await timed([Names.Conflict, Names.Conflict]), ConsoleRegistrationState.Refused, 'control: two refused ticks')
            assert.equal(await timed([Names.Conflict, Names.BadRequest, Names.Conflict]), ConsoleRegistrationState.Registered, 'a 400 resets the streak')
            assert.equal(await timed([Names.Unauthorized, Names.ServerError, Names.Unauthorized]), ConsoleRegistrationState.Registered, 'a 500 resets the streak')
        }
        finally
        {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('a timed-out send is reported and the next send still runs', { timeout: Names.TestTimeoutMs }, async () =>
    {
        // Deterministic: the first request is held by the server until the test expires its deadline by hand (no wall-clock
        // timeout), and it is counted only once it has reached the server.
        let calls = 0
        const firstArrived = new Arrival()
        const url = await listen(() =>
        {
            calls++
            if (calls === 1)
            {
                firstArrived.Mark()
                return undefined
            }
            return { status: Names.Ok, body: Names.OkBody }
        })
        const root = mkdtempSync(join(tmpdir(), Names.TempPrefix))
        try
        {
            const store = await ConsoleEmailDomainStore.Open(join(root, ConsoleEmailDomainStore.FileName), Names.TenantId, [Names.Domain])
            const lines: string[] = []
            const timer = new FakeTimer()
            const deadline = new FakeDeadline()
            const s = new ConsoleAdvertSender(new HttpConsoleAdvertTransport(url, Names.Token, Names.HiveId, HttpConsoleAdvertTransport.RequestTimeoutMs, deadline),
                new FakeAccounts([Names.OwnerEmail]), store, randomBytes(Names.KeyBytes), Names.ConsoleUrl, timer, line => lines.push(line))
            const starting = s.Start()
            await firstArrived.Reached
            deadline.Expire()
            await starting
            assert.deepEqual(lines, [Names.SendFailedPrefix + Names.UnreachableMessage])
            timer.Tick()
            await s.Idle()
            assert.equal(calls, 2)
            assert.equal(lines.length, 1, 'the second send succeeded')
            assert.deepEqual(deadline.Requested, [HttpConsoleAdvertTransport.RequestTimeoutMs, HttpConsoleAdvertTransport.RequestTimeoutMs])
            s.Stop()
        }
        finally
        {
            rmSync(root, { recursive: true, force: true })
        }
    })
})
