import { readFile } from 'node:fs/promises'
import { Signal, type IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { AtomicJsonFile, SerialRuns } from './atomic-json-file.js'

/** Whether the platform still takes this console's adverts. The values are the persisted `state` field. */
export enum ConsoleRegistrationState
{
    Registered = 'registered',
    Refused = 'refused',
}

/** How the control plane answered one advert: 200 (Accepted), 401 / 409 (Refused), anything else or no answer (Transient). */
export enum AdvertOutcome
{
    Accepted,
    Refused,
    Transient,
}

/** What caused an advert send: the first send at Start, the interval Timer, or an account / domain Change. */
export enum AdvertTrigger
{
    Start,
    Timer,
    Change,
}

/**
 * A Signal whose subscribers are isolated from each other: each handler runs inside its own try/catch, so one that throws is
 * reported through `onError` and the handlers after it are still called (todl-runtime's Signal.emit is a plain loop that a
 * throwing handler would end). Subscribing, disposing and `subscriberCount` are Signal's own.
 */
class ListenerIsolatingSignal<T> extends Signal<T>
{
    public constructor(private readonly onError: (err: unknown) => void)
    {
        super()
    }

    public override subscribe(handler: (value: T) => void): IDisposable
    {
        return super.subscribe(value =>
        {
            try
            {
                handler(value)
            }
            catch (err)
            {
                this.onError(err)
            }
        })
    }
}

/**
 * The in-hive console's registration with the platform, kept in `<dataRoot>/console-registration.json`
 * (`{ "state": "registered" | "refused" }`). A missing, empty, unreadable or malformed file opens Registered, so a bad file
 * never locks the desktop out. Observe applies each advert outcome: an Accepted answer from any send restores Registered;
 * RefusalThreshold consecutive Refused answers on Timer sends make it Refused; a Transient Timer answer resets that streak;
 * Start and Change sends that are refused or transient change nothing. The streak lives in memory only: a restarted console
 * keeps its state but counts again from 0. Writes are atomic and serialised; a failed write keeps the in-memory state, is
 * logged (a fixed sentence plus the error's name, never the path) and is retried on the next observation.
 *
 * `Changed` fires, carrying the new state, only when the state actually changes. Subscribe with
 * `registration.Changed.subscribe(state => ...)` and dispose the returned handle to stop listening. Each subscriber is
 * isolated: one that throws is logged by error name and every other subscriber is still told.
 */
export class ConsoleRegistration
{
    public static readonly FileName = 'console-registration.json'
    public static readonly RefusalThreshold = 2
    public static readonly RefusedError = 'console-not-registered'
    public static readonly RefusedMessage = 'This console is no longer registered with the platform. Ask your administrator.'
    public static readonly RefusedBody: Readonly<{ error: string; message: string }> =
        Object.freeze({ error: ConsoleRegistration.RefusedError, message: ConsoleRegistration.RefusedMessage })
    private static readonly StateKey = 'state'
    private static readonly Utf8 = 'utf8'
    private static readonly WriteFailedPrefix = '[console-registration] state not saved: '
    private static readonly ListenerFailedPrefix = '[console-registration] a Changed listener failed: '
    private static readonly UnknownErrorName = 'unknown error'

    public readonly Changed: Signal<ConsoleRegistrationState>
    private readonly writes = new SerialRuns()
    private state: ConsoleRegistrationState
    /** The state the file is known to hold; differs from `state` while a write is pending or has failed. */
    private persisted: ConsoleRegistrationState
    private streak = 0

    private constructor(
        private readonly filePath: string,
        state: ConsoleRegistrationState,
        private readonly log: (line: string) => void)
    {
        this.state = state
        this.persisted = state
        this.Changed = new ListenerIsolatingSignal<ConsoleRegistrationState>(
            err => this.Report(ConsoleRegistration.ListenerFailedPrefix + ConsoleRegistration.NameOf(err)))
    }

    /** Never throws and never writes: a missing, empty, unreadable or malformed file opens Registered. `log` takes failure lines. */
    public static async Open(path: string, log: (line: string) => void = line => console.error(line)): Promise<ConsoleRegistration>
    {
        let text: string
        try
        {
            text = await readFile(path, ConsoleRegistration.Utf8)
        }
        catch
        {
            return new ConsoleRegistration(path, ConsoleRegistrationState.Registered, log)
        }
        return new ConsoleRegistration(path, ConsoleRegistration.StateIn(text), log)
    }

    /**
     * Opens Registered without reading the file, for a console with no advert sender: only an advert answer could ever
     * restore Registered there, so a saved refusal must not be honoured. Writes nothing until an observation changes the state.
     */
    public static OpenRegistered(path: string, log: (line: string) => void = line => console.error(line)): ConsoleRegistration
    {
        return new ConsoleRegistration(path, ConsoleRegistrationState.Registered, log)
    }

    public get State(): ConsoleRegistrationState
    {
        return this.state
    }

    public get IsRefused(): boolean
    {
        return this.state === ConsoleRegistrationState.Refused
    }

    /** Applies one advert outcome (see the class comment), signals a change, then persists. Never rejects. */
    public async Observe(outcome: AdvertOutcome, trigger: AdvertTrigger): Promise<void>
    {
        const next = this.Apply(outcome, trigger)
        if (next !== this.state)
        {
            this.state = next
            this.Emit(next)
        }
        await this.Persist()
    }

    /** The persisted state when `text` is `{ "state": "registered" | "refused" }`; Registered otherwise. */
    private static StateIn(text: string): ConsoleRegistrationState
    {
        let parsed: unknown
        try
        {
            parsed = JSON.parse(text)
        }
        catch
        {
            return ConsoleRegistrationState.Registered
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        {
            return ConsoleRegistrationState.Registered
        }
        const value = (parsed as Record<string, unknown>)[ConsoleRegistration.StateKey]
        return value === ConsoleRegistrationState.Refused ? ConsoleRegistrationState.Refused : ConsoleRegistrationState.Registered
    }

    /** Updates the streak and returns the state the outcome leads to. */
    private Apply(outcome: AdvertOutcome, trigger: AdvertTrigger): ConsoleRegistrationState
    {
        if (outcome === AdvertOutcome.Accepted)
        {
            this.streak = 0
            return ConsoleRegistrationState.Registered
        }
        if (trigger !== AdvertTrigger.Timer)
        {
            return this.state
        }
        if (outcome === AdvertOutcome.Transient)
        {
            this.streak = 0
            return this.state
        }
        this.streak++
        return this.streak >= ConsoleRegistration.RefusalThreshold ? ConsoleRegistrationState.Refused : this.state
    }

    /**
     * Subscribers are isolated by ListenerIsolatingSignal, so nothing reaches here from them; the guard only keeps Observe's
     * never-rejects promise should the signal itself fail.
     */
    private Emit(state: ConsoleRegistrationState): void
    {
        try
        {
            this.Changed.emit(state)
        }
        catch
        {
            // The registration has already changed; persisting still runs.
        }
    }

    /** Hands a failure line to the log; a throwing log is ignored so Observe never rejects. */
    private Report(line: string): void
    {
        try
        {
            this.log(line)
        }
        catch
        {
            // Nowhere left to report to.
        }
    }

    private static NameOf(err: unknown): string
    {
        return err instanceof Error ? err.name : ConsoleRegistration.UnknownErrorName
    }

    /** Writes the current state when the file is not known to hold it; a failure leaves `persisted` stale, so the next call retries. */
    private Persist(): Promise<void>
    {
        return this.writes.Run(async () =>
        {
            const state = this.state
            if (state === this.persisted)
            {
                return
            }
            try
            {
                await AtomicJsonFile.Write(this.filePath, { [ConsoleRegistration.StateKey]: state })
                this.persisted = state
            }
            catch (err)
            {
                // Kept in memory; retried on the next observation.
                this.Report(ConsoleRegistration.WriteFailedPrefix + ConsoleRegistration.NameOf(err))
            }
        })
    }
}
