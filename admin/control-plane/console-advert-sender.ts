import { Disposable, Signal, type IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { ConsoleFingerprint, type ConsoleAdvertAnswer, type ConsoleAdvertBody } from './console-advert-contract.js'
import { ConsoleEmailDomainStore, type IConsoleDomainVerifyChannel } from './console-email-domain-store.js'
import { AdvertOutcome, AdvertTrigger, type ConsoleRegistration } from './console-registration.js'
import { DomainVerificationRecord, type DomainVerificationAnswer } from './domain-verification-record.js'
import { EmailDomainPolicy } from './email-domain-policy.js'
import type { TenantRecord } from './platform-records.js'
import { DomainNotClaimedError, DomainVerificationUnavailableError, DomainVerifyThrottledError } from './tenant-api/tenant-email-domains.js'
import { OwnerResetTime } from './tenant-owner.js'

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
    /** The sentence a non-2xx answer carries, followed by its HTTP status. */
    public static readonly StatusMessagePrefix = 'The platform agent channel answered HTTP '
    private static readonly ErrorName = 'ConsoleAdvertUnavailableError'

    public constructor(message: string)
    {
        super(message)
        this.name = ConsoleAdvertUnavailableError.ErrorName
    }
}

/**
 * The control plane refused the advert: HTTP 401 (hive token deregistered) or 409 (console not enabled for the hive). Still a
 * ConsoleAdvertUnavailableError with the same message, so the send-failed log line is unchanged.
 */
export class ConsoleAdvertRefusedError extends ConsoleAdvertUnavailableError
{
    private static readonly RefusedName = 'ConsoleAdvertRefusedError'

    public constructor(public readonly Status: number)
    {
        super(ConsoleAdvertUnavailableError.StatusMessagePrefix + Status)
        this.name = ConsoleAdvertRefusedError.RefusedName
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
 * MaxAnswerBytes are read, keeping `ownerResetAt` when it is a string Date.parse accepts and, when `domainVerifications` is an
 * array, its entries DomainVerificationRecord.ParseAnswer accepts (at most EmailDomainPolicy.MaxDomains); a malformed or
 * oversized answer yields {}. The control plane's `refusedEmailDomains` is ignored because the console validates with the
 * same EmailDomainPolicy. A request that outlives `timeoutMs`, or is aborted by the caller, reads as unreachable, so a hung
 * control plane cannot hold the sender's one in-flight send for ever.
 *
 * It is also the console's verify channel: VerifyDomain POSTs `{ domain }` to `.../console/verify-domain` the same way and maps
 * every answer to a fixed console sentence (never the server's text). Its failures are verify errors, never advert errors, so
 * they never reach the registration.
 */
export class HttpConsoleAdvertTransport implements IConsoleAdvertTransport, IConsoleDomainVerifyChannel
{
    public static readonly RequestTimeoutMs = 30000
    /**
     * The most of a 200 answer read; a longer answer is dropped as malformed. The receiver refuses an advert of more than
     * EmailDomainPolicy.MaxDomains (20) raw domains, so refused plus accepted domains are at most 20 together. The largest
     * legitimate answer is therefore 20 accepted domains at the 253-character DNS maximum, each with a full verification answer
     * (253 + the 43-character token + about 110 for the keys, the longest state and lastCheckedAt, about 409 bytes), plus the
     * keys and ownerResetAt: roughly 8.3 KB. 32 KiB leaves about four times that as headroom while still bounding what a
     * hostile answer can make the console buffer. A verify answer (one verification) is far below it.
     */
    public static readonly MaxAnswerBytes = 32768
    private static readonly OwnerResetKey = 'ownerResetAt'
    private static readonly DomainVerificationsKey = 'domainVerifications'
    private static readonly VerificationKey = 'verification'
    private static readonly Utf8 = 'utf8'
    private static readonly AgentPrefix = '/agent/hives/'
    private static readonly ConsoleSegment = '/console'
    private static readonly VerifyDomainSegment = '/console/verify-domain'
    private static readonly StatusOk = 200
    private static readonly StatusConflict = 409
    private static readonly StatusTooManyRequests = 429
    private static readonly NotListedPrefix = 'The platform does not list '
    private static readonly NotListedSuffix = ' for this console yet. Try again after the console reports its domains.'
    private static readonly ThrottledMessage = 'Too many verification attempts. Try again in a few minutes.'
    private static readonly AuthorizationHeader = 'Authorization'
    private static readonly BearerPrefix = 'Bearer '
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly JsonType = 'application/json'
    private static readonly MethodPost = 'POST'
    private static readonly UnreachableMessage = 'The platform agent channel is unreachable'
    /** The answers that mean the platform no longer takes this console: 401 (hive token deregistered) and 409 (console not enabled for the hive). */
    private static readonly RefusedStatuses: ReadonlySet<number> = new Set([401, 409])

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
        const response = await this.Post(T.ConsoleSegment, body, signal)
        if (response === undefined)
        {
            throw new ConsoleAdvertUnavailableError(T.UnreachableMessage)
        }
        if (!response.ok)
        {
            await T.Drain(response)
            if (T.RefusedStatuses.has(response.status))
            {
                throw new ConsoleAdvertRefusedError(response.status)
            }
            throw new ConsoleAdvertUnavailableError(ConsoleAdvertUnavailableError.StatusMessagePrefix + response.status)
        }
        return T.AnswerOf(await T.BoundedText(response))
    }

    /**
     * Asks the platform to check `domain` (the console's normalised value) now and answers its verification. Throws
     * DomainNotClaimedError (409), DomainVerifyThrottledError (429) or DomainVerificationUnavailableError (any other status, an
     * unreachable or timed-out platform, or a 200 whose `verification` ParseAnswer refuses); each carries a fixed sentence.
     */
    public async VerifyDomain(domain: string): Promise<DomainVerificationAnswer>
    {
        const T = HttpConsoleAdvertTransport
        const response = await this.Post(T.VerifyDomainSegment, { domain })
        if (response === undefined)
        {
            throw new DomainVerificationUnavailableError(ConsoleEmailDomainStore.PlatformUnavailableMessage)
        }
        if (response.status !== T.StatusOk)
        {
            await T.Drain(response)
            if (response.status === T.StatusConflict)
            {
                throw new DomainNotClaimedError(T.NotListedPrefix + domain + T.NotListedSuffix)
            }
            if (response.status === T.StatusTooManyRequests)
            {
                throw new DomainVerifyThrottledError(T.ThrottledMessage)
            }
            throw new DomainVerificationUnavailableError(ConsoleEmailDomainStore.PlatformUnavailableMessage)
        }
        const parsed = T.ObjectOf(await T.BoundedText(response))
        const verification = parsed === undefined ? undefined : DomainVerificationRecord.ParseAnswer(parsed[T.VerificationKey])
        if (verification === undefined)
        {
            throw new DomainVerificationUnavailableError(ConsoleEmailDomainStore.PlatformUnavailableMessage)
        }
        return verification
    }

    /** POSTs `body` as JSON to `<baseUrl>/agent/hives/<hiveId><segment>` with the bearer and the deadline; undefined when the request fails or is aborted. */
    private async Post(segment: string, body: unknown, signal?: AbortSignal): Promise<Response | undefined>
    {
        const T = HttpConsoleAdvertTransport
        const timeout = this.deadline.SignalAfter(this.timeoutMs)
        try
        {
            return await fetch(this.baseUrl + T.AgentPrefix + encodeURIComponent(this.hiveId) + segment, {
                method: T.MethodPost,
                headers: { [T.AuthorizationHeader]: T.BearerPrefix + this.bearerToken, [T.ContentTypeHeader]: T.JsonType },
                body: JSON.stringify(body),
                signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
            })
        }
        catch
        {
            return undefined
        }
    }

    /**
     * What the console takes from a 200 advert answer's `text`: ownerResetAt when it is a string Date.parse accepts, and
     * domainVerifications when it is an array (its entries ParseAnswer accepts, at most EmailDomainPolicy.MaxDomains). Text that
     * is missing, oversized or not a JSON object yields {}.
     */
    private static AnswerOf(text: string | undefined): ConsoleAdvertAnswer
    {
        const T = HttpConsoleAdvertTransport
        const parsed = T.ObjectOf(text)
        if (parsed === undefined)
        {
            return {}
        }
        const answer: ConsoleAdvertAnswer = {}
        const resetAt = parsed[T.OwnerResetKey]
        if (OwnerResetTime.IsWellFormed(resetAt))
        {
            answer.ownerResetAt = resetAt
        }
        const verifications = parsed[T.DomainVerificationsKey]
        if (Array.isArray(verifications))
        {
            answer.domainVerifications = verifications
                .map(v => DomainVerificationRecord.ParseAnswer(v))
                .filter((v): v is DomainVerificationAnswer => v !== undefined)
                .slice(0, EmailDomainPolicy.MaxDomains)
        }
        return answer
    }

    /** The JSON object `text` holds; undefined when the text is missing, not JSON, or not a (non-array) object. */
    private static ObjectOf(text: string | undefined): Record<string, unknown> | undefined
    {
        if (text === undefined)
        {
            return undefined
        }
        let parsed: unknown
        try
        {
            parsed = JSON.parse(text)
        }
        catch
        {
            return undefined
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        {
            return undefined
        }
        return parsed as Record<string, unknown>
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
 * within one interval; the follower's failure is logged by error name only and never fails the advert. Every 200 answer's
 * domain verifications (none when it carries none) are handed to the domain store first, so the console shows the platform's
 * state as of the last answer. Neither happens once the sender has stopped. Each send's outcome
 * (Accepted, Refused on ConsoleAdvertRefusedError, Transient on any other failure) is handed to the registration (when one is
 * given) with the send's trigger; a queued send that merged a timer tick counts as a Timer send.
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
    /** The trigger of the one send queued behind the one in flight (Timer when any merged request was Timer); undefined when none. */
    private queued: AdvertTrigger | undefined
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
        private readonly follower?: IOwnerResetFollower,
        private readonly registration?: ConsoleRegistration)
    {
    }

    /**
     * Sends once (awaited, never throws; trigger Start), then every IntervalMs (Timer) and on accounts.Changed / domains.Changed
     * (Change). A second Start is a no-op.
     */
    public async Start(): Promise<void>
    {
        if (this.started)
        {
            return
        }
        this.started = true
        this.stopped = false
        this.subscriptions.push(this.accounts.Changed.subscribe(() => { void this.SendNow(AdvertTrigger.Change) }))
        this.subscriptions.push(this.domains.Changed.subscribe(() => { void this.SendNow(AdvertTrigger.Change) }))
        this.subscriptions.push(this.timer.Every(ConsoleAdvertSender.IntervalMs, () => { void this.SendNow(AdvertTrigger.Timer) }))
        await this.SendNow(AdvertTrigger.Start)
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

    /**
     * At most one send in flight; requests during a send queue exactly one more, which counts as Timer when any merged request
     * was Timer. `trigger` decides whether the outcome counts toward the registration's refusal threshold. Never throws.
     */
    public SendNow(trigger: AdvertTrigger = AdvertTrigger.Change): Promise<void>
    {
        if (this.inFlight !== undefined)
        {
            this.queued = this.queued === AdvertTrigger.Timer ? AdvertTrigger.Timer : trigger
            return this.inFlight
        }
        this.inFlight = this.Drain(trigger)
        return this.inFlight
    }

    /** { consoleUrl, fingerprints: sorted unique ConsoleFingerprint.Of(key, e) of accounts.Emails(), emailDomains: domains.Domains } */
    public Body(): ConsoleAdvertBody
    {
        const fingerprints = new Set(this.accounts.Emails().map(e => ConsoleFingerprint.Of(this.fingerprintKey, e)))
        return { consoleUrl: this.consoleUrl, fingerprints: [...fingerprints].sort(), emailDomains: [...this.domains.Domains] }
    }

    private async Drain(first: AdvertTrigger): Promise<void>
    {
        let next: AdvertTrigger | undefined = first
        try
        {
            do
            {
                this.queued = undefined
                await this.SendOnce(next)
                next = this.queued
            }
            while (next !== undefined && !this.stopped)
        }
        finally
        {
            this.queued = undefined
            this.inFlight = undefined
        }
    }

    /** One send; its outcome is observed (and a failure logged) unless the sender has stopped meanwhile. */
    private async SendOnce(trigger: AdvertTrigger): Promise<void>
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
                await this.Observe(err instanceof ConsoleAdvertRefusedError ? AdvertOutcome.Refused : AdvertOutcome.Transient, trigger)
            }
            return
        }
        finally
        {
            this.sending = undefined
        }
        await this.Observe(AdvertOutcome.Accepted, trigger)
        if (!this.stopped)
        {
            this.domains.AdoptVerifications(answer.domainVerifications ?? [])
        }
        await this.Follow(answer)
    }

    /** Hands the outcome to the registration, when there is one and the sender has not stopped (Observe never rejects). */
    private async Observe(outcome: AdvertOutcome, trigger: AdvertTrigger): Promise<void>
    {
        if (this.registration === undefined || this.stopped)
        {
            return
        }
        await this.registration.Observe(outcome, trigger)
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
            if (!this.stopped)
            {
                this.log(ConsoleAdvertSender.OwnerResetFailedPrefix + ConsoleAdvertSender.NameOf(err))
            }
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
