import { Disposable, Signal, type IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { ConsoleFingerprint, type ConsoleAdvertBody } from './console-advert-contract.js'
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
 * documents. `Changed` never emits today, which is accepted; Plan 3, and any later account create / delete / email-change path
 * in the console, MUST emit it so the advert is re-sent at once.
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

/** Delivers one advert to the control plane; throws on any failure. */
export interface IConsoleAdvertTransport
{
    Send(body: ConsoleAdvertBody): Promise<void>
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

/**
 * POSTs the advert to `<baseUrl>/agent/hives/<hiveId>/console` with the hive's agent bearer (only in the Authorization header).
 * The answer's body is drained, never read into an error; the control plane's `refusedEmailDomains` is ignored because the
 * console validates with the same EmailDomainPolicy.
 */
export class HttpConsoleAdvertTransport implements IConsoleAdvertTransport
{
    private static readonly AgentPrefix = '/agent/hives/'
    private static readonly ConsoleSegment = '/console'
    private static readonly AuthorizationHeader = 'Authorization'
    private static readonly BearerPrefix = 'Bearer '
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly JsonType = 'application/json'
    private static readonly MethodPost = 'POST'
    private static readonly RequestTimeoutMs = 30000
    private static readonly UnreachableMessage = 'The platform agent channel is unreachable'
    private static readonly FailedMessagePrefix = 'The platform agent channel answered HTTP '

    public constructor(
        private readonly baseUrl: string,
        private readonly bearerToken: string,
        private readonly hiveId: string)
    {
    }

    public async Send(body: ConsoleAdvertBody): Promise<void>
    {
        const T = HttpConsoleAdvertTransport
        let response: Response
        try
        {
            response = await fetch(this.baseUrl + T.AgentPrefix + encodeURIComponent(this.hiveId) + T.ConsoleSegment, {
                method: T.MethodPost,
                headers: { [T.AuthorizationHeader]: T.BearerPrefix + this.bearerToken, [T.ContentTypeHeader]: T.JsonType },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(T.RequestTimeoutMs),
            })
        }
        catch
        {
            throw new ConsoleAdvertUnavailableError(T.UnreachableMessage)
        }
        await T.Drain(response)
        if (!response.ok)
        {
            throw new ConsoleAdvertUnavailableError(T.FailedMessagePrefix + response.status)
        }
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
 * logged (a fixed sentence or the error's name, never a body, token or email) and the next tick or change retries.
 */
export class ConsoleAdvertSender
{
    public static readonly IntervalMs = 5 * 60 * 1000
    private static readonly FailedPrefix = '[console-advert] send failed: '
    private static readonly UnknownErrorName = 'unknown error'

    private readonly subscriptions: IDisposable[] = []
    private inFlight: Promise<void> | undefined
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
        private readonly log: (line: string) => void = line => console.error(line))
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

    /** Ends the timer and the subscriptions; a send queued behind one in flight is dropped. */
    public Stop(): void
    {
        this.stopped = true
        this.started = false
        for (const subscription of this.subscriptions.splice(0))
        {
            subscription.dispose()
        }
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
        try
        {
            await this.transport.Send(this.Body())
        }
        catch (err)
        {
            this.log(ConsoleAdvertSender.FailedPrefix + ConsoleAdvertSender.Describe(err))
        }
    }

    /** ConsoleAdvertUnavailableError carries a fixed sentence (plus status); anything else is reduced to its name. */
    private static Describe(err: unknown): string
    {
        if (err instanceof ConsoleAdvertUnavailableError)
        {
            return err.message
        }
        return err instanceof Error ? err.name : ConsoleAdvertSender.UnknownErrorName
    }
}
