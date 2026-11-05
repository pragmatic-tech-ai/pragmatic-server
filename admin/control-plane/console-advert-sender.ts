import { Disposable, Signal, type IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { ConsoleFingerprint, type ConsoleAdvertAnswer, type ConsoleAdvertBody } from './console-advert-contract.js'
import type { ConsoleEmailDomainStore } from './console-email-domain-store.js'
import type { TenantRecord } from './platform-records.js'

/** The console's sign-in accounts, as account emails; `Changed` fires whenever that list may have changed. */
export interface IConsoleAccountSource
{
    Emails(): readonly string[]
    readonly Changed: Signal<void>
}

/**
 * The console's sign-in accounts: today only the seeded Owner (TenantRecord.ownerEmail), the same rule TenantAccountIndex
 * documents. `Changed` never emits today, which is accepted; any later account create / delete / email-change path in the
 * console MUST emit it so the advert is re-sent at once.
 */
export class SeededConsoleAccounts implements IConsoleAccountSource
{
    public readonly Changed = new Signal<void>()
    private readonly emails: readonly string[]

    public constructor(tenant: TenantRecord)
    {
        const owner = tenant.ownerEmail?.trim()
        this.emails = owner === undefined || owner.length === 0 ? [] : [owner]
    }

    public Emails(): readonly string[]
    {
        return this.emails
    }
}

/** Delivers one advert to the control plane and returns what the console takes from its answer; throws on any failure, including an abort through `signal`. */
export interface IConsoleAdvertTransport
{
    Send(body: ConsoleAdvertBody, signal?: AbortSignal): Promise<ConsoleAdvertAnswer>
}

/** Acts on the Owner reset time a 200 advert answer carried (ConsoleOwnerResetFollower); returns whether it revoked. */
export interface IOwnerResetFollower
{
    Apply(resetAt: string | undefined): Promise<boolean>
}

/** The agent channel did not take the advert; the message is a fixed sentence (plus the HTTP status), never a body or the token. */
export class ConsoleAdvertUnavailableError extends Error
{
    private static readonly ErrorName = 'ConsoleAdvertUnavailableError'

    public constructor(message: string)
    {
        super(message)
        this.name = ConsoleAdvertUnavailableError.ErrorName
    }
}

/** Where a send's deadline comes from: a signal that aborts once a request has run for `timeoutMs`. Tests expire it by hand. */
export interface IRequestDeadline
{
    SignalAfter(timeoutMs: number): AbortSignal
}

/** The real deadline: AbortSignal.timeout on the wall clock. */
export class WallClockDeadline implements IRequestDeadline
{
    public SignalAfter(timeoutMs: number): AbortSignal
    {
        return AbortSignal.timeout(timeoutMs)
    }
}

/**
 * POSTs the advert to `<baseUrl>/agent/hives/<hiveId>/console` with the hive's agent bearer (only in the Authorization header).
 * The answer's body is never read into an error or a log: a failed answer's body is drained, and of a 200 answer at most
 * MaxAnswerBytes are read, keeping only `ownerResetAt` when it is a string Date.parse accepts (a malformed, oversized or
 * reset-less answer yields {}). The control plane's `refusedEmailDomains` is ignored because the console validates with the
 * same EmailDomainPolicy. A request that outlives `timeoutMs`, or is aborted by the caller, reads as unreachable, so a hung
 * control plane cannot hold the sender's one in-flight send for ever.
 */
export class HttpConsoleAdvertTransport implements IConsoleAdvertTransport
{
    public static readonly RequestTimeoutMs = 30000
    /** The most of a 200 answer read; a longer answer is dropped as malformed. */
    public static readonly MaxAnswerBytes = 4096
    private static readonly OwnerResetKey = 'ownerResetAt'
    private static readonly Utf8 = 'utf8'
    private static readonly AgentPrefix = '/agent/hives/'
    private static readonly ConsoleSegment = '/console'
    private static readonly AuthorizationHeader = 'Authorization'
    private static readonly BearerPrefix = 'Bearer '
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly JsonType = 'application/json'
    private static readonly MethodPost = 'POST'
    private static readonly UnreachableMessage = 'The platform agent channel is unreachable'
    private static readonly FailedMessagePrefix = 'The platform agent channel answered HTTP '

    public constructor(
        private readonly baseUrl: string,
        private readonly bearerToken: string,
        private readonly hiveId: string,
        private readonly timeoutMs: number = HttpConsoleAdvertTransport.RequestTimeoutMs,
        private readonly deadline: IRequestDeadline = new WallClockDeadline())
    {
    }

    public async Send(body: ConsoleAdvertBody, signal?: AbortSignal): Promise<ConsoleAdvertAnswer>
    {
        const T = HttpConsoleAdvertTransport
        const timeout = this.deadline.SignalAfter(this.timeoutMs)
        let response: Response
        try
        {
            response = await fetch(this.baseUrl + T.AgentPrefix + encodeURIComponent(this.hiveId) + T.ConsoleSegment, {
                method: T.MethodPost,
                headers: { [T.AuthorizationHeader]: T.BearerPrefix + this.bearerToken, [T.ContentTypeHeader]: T.JsonType },
                body: JSON.stringify(body),
                signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
            })
        }
        catch
        {
            throw new ConsoleAdvertUnavailableError(T.UnreachableMessage)
        }
        if (!response.ok)
        {
            await T.Drain(response)
            throw new ConsoleAdvertUnavailableError(T.FailedMessagePrefix + response.status)
        }
        return T.AnswerOf(await T.BoundedText(response))
    }

    /** { ownerResetAt } when `text` is a JSON object whose ownerResetAt is a string Date.parse accepts; otherwise {}. */
    private static AnswerOf(text: string | undefined): ConsoleAdvertAnswer
    {
        if (text === undefined)
        {
            return {}
        }
        let parsed: unknown
        try
        {
            parsed = JSON.parse(text)
        }
        catch
        {
            return {}
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        {
            return {}
        }
        const value = (parsed as Record<string, unknown>)[HttpConsoleAdvertTransport.OwnerResetKey]
        return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? { ownerResetAt: value } : {}
    }

    /** The answer's text when it fits MaxAnswerBytes; undefined when it is longer (the rest is not read) or its read fails. */
    private static async BoundedText(response: Response): Promise<string | undefined>
    {
        const reader = response.body?.getReader()
        if (reader === undefined)
        {
            return undefined
        }
        const chunks: Uint8Array[] = []
        let total = 0
        try
        {
            for (let next = await reader.read(); !next.done; next = await reader.read())
            {
                total += next.value.byteLength
                if (total > HttpConsoleAdvertTransport.MaxAnswerBytes)
                {
                    await reader.cancel().catch(() => undefined)
                    return undefined
                }
                chunks.push(next.value)
            }
        }
        catch
        {
            return undefined
        }
        return Buffer.concat(chunks).toString(HttpConsoleAdvertTransport.Utf8)
    }

    private static async Drain(response: Response): Promise<void>
    {
        try
        {
            await response.arrayBuffer()
        }
        catch
        {
            // The body is discarded; a failed drain changes nothing.
        }
    }
}

/** Calls `tick` every `intervalMs` until the returned handle is disposed. */
export interface IAdvertTimer
{
    Every(intervalMs: number, tick: () => void): IDisposable
}

/** setInterval, unref'd so the advert never keeps the process alive. */
export class IntervalAdvertTimer implements IAdvertTimer
{
    public Every(intervalMs: number, tick: () => void): IDisposable
    {
        const handle = setInterval(tick, intervalMs)
        handle.unref()
        return new Disposable(() => clearInterval(handle))
    }
}

/**
 * Keeps the control plane told where this console is, whose accounts it holds (keyed fingerprints, never emails) and which
 * email domains it claims: once at start, every IntervalMs, and at once on an account or domain change. A failed send is
 * logged (a fixed sentence or the error's name, never a body, token or email) and the next tick or change retries. Every 200
 * answer is handed to the Owner-reset follower (when one is given), so an operator Owner reset ends the Owner's sessions here
 * within one interval; the follower's failure is logged by error name only and never fails the advert.
 */
export class ConsoleAdvertSender
{
    public static readonly IntervalMs = 5 * 60 * 1000
    private static readonly FailedPrefix = '[console-advert] send failed: '
    private static readonly OwnerResetFailedPrefix = '[console-advert] owner reset not applied: '
    private static readonly UnknownErrorName = 'unknown error'

    private readonly subscriptions: IDisposable[] = []
    private inFlight: Promise<void> | undefined
    private sending: AbortController | undefined
    private queued = false
    private stopped = false
    private started = false

    public constructor(
        private readonly transport: IConsoleAdvertTransport,
        private readonly accounts: IConsoleAccountSource,
        private readonly domains: ConsoleEmailDomainStore,
        private readonly fingerprintKey: Buffer,
        private readonly consoleUrl: string,
        private readonly timer: IAdvertTimer = new IntervalAdvertTimer(),
        private readonly log: (line: string) => void = line => console.error(line),
        private readonly follower?: IOwnerResetFollower)
    {
    }

    /** Sends once (awaited, never throws), then every IntervalMs and on accounts.Changed / domains.Changed. A second Start is a no-op. */
    public async Start(): Promise<void>
    {
        if (this.started)
        {
            return
        }
        this.started = true
        this.stopped = false
        this.subscriptions.push(this.accounts.Changed.subscribe(() => { void this.SendNow() }))
        this.subscriptions.push(this.domains.Changed.subscribe(() => { void this.SendNow() }))
        this.subscriptions.push(this.timer.Every(ConsoleAdvertSender.IntervalMs, () => { void this.SendNow() }))
        await this.SendNow()
    }

    /**
     * Ends the timer and the subscriptions, aborts the send in flight and drops one queued behind it. Nothing is logged for a
     * send that ends after Stop; await Idle() to know it has ended.
     */
    public Stop(): void
    {
        this.stopped = true
        this.started = false
        for (const subscription of this.subscriptions.splice(0))
        {
            subscription.dispose()
        }
        this.sending?.abort()
    }

    /** Settles once no send is in flight (at once when none is). Never rejects. */
    public Idle(): Promise<void>
    {
        return this.inFlight ?? Promise.resolve()
    }

    /** At most one send in flight; changes during a send queue exactly one more. Never throws. */
    public SendNow(): Promise<void>
    {
        if (this.inFlight !== undefined)
        {
            this.queued = true
            return this.inFlight
        }
        this.inFlight = this.Drain()
        return this.inFlight
    }

    /** { consoleUrl, fingerprints: sorted unique ConsoleFingerprint.Of(key, e) of accounts.Emails(), emailDomains: domains.Domains } */
    public Body(): ConsoleAdvertBody
    {
        const fingerprints = new Set(this.accounts.Emails().map(e => ConsoleFingerprint.Of(this.fingerprintKey, e)))
        return { consoleUrl: this.consoleUrl, fingerprints: [...fingerprints].sort(), emailDomains: [...this.domains.Domains] }
    }

    private async Drain(): Promise<void>
    {
        try
        {
            do
            {
                this.queued = false
                await this.SendOnce()
            }
            while (this.queued && !this.stopped)
        }
        finally
        {
            this.queued = false
            this.inFlight = undefined
        }
    }

    private async SendOnce(): Promise<void>
    {
        const sending = new AbortController()
        this.sending = sending
        let answer: ConsoleAdvertAnswer
        try
        {
            answer = await this.transport.Send(this.Body(), sending.signal)
        }
        catch (err)
        {
            if (!this.stopped)
            {
                this.log(ConsoleAdvertSender.FailedPrefix + ConsoleAdvertSender.Describe(err))
            }
            return
        }
        finally
        {
            this.sending = undefined
        }
        await this.Follow(answer)
    }

    /**
     * Hands a 200 answer's Owner reset to the follower; its failure is logged by error name only and never fails the advert.
     * Skipped once stopped (nothing runs or logs after Stop); the control plane keeps the reset, so the next start's first
     * advert hands it over again.
     */
    private async Follow(answer: ConsoleAdvertAnswer): Promise<void>
    {
        if (this.follower === undefined || this.stopped)
        {
            return
        }
        try
        {
            await this.follower.Apply(answer.ownerResetAt)
        }
        catch (err)
        {
            this.log(ConsoleAdvertSender.OwnerResetFailedPrefix + ConsoleAdvertSender.NameOf(err))
        }
    }

    /** ConsoleAdvertUnavailableError carries a fixed sentence (plus status); anything else is reduced to its name. */
    private static Describe(err: unknown): string
    {
        if (err instanceof ConsoleAdvertUnavailableError)
        {
            return err.message
        }
        return ConsoleAdvertSender.NameOf(err)
    }

    private static NameOf(err: unknown): string
    {
        return err instanceof Error ? err.name : ConsoleAdvertSender.UnknownErrorName
    }
}
