import { readFile } from 'node:fs/promises'
import { Signal } from '@pragmatic-tech-ai/todl-runtime'
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
 * The in-hive console's registration with the platform, kept in `<dataRoot>/console-registration.json`
 * (`{ "state": "registered" | "refused" }`). A missing, empty, unreadable or malformed file opens Registered, so a bad file
 * never locks the desktop out. Observe applies each advert outcome: an Accepted answer from any send restores Registered;
 * RefusalThreshold consecutive Refused answers on Timer sends make it Refused; a Transient Timer answer resets that streak;
 * Start and Change sends that are refused or transient change nothing. The streak lives in memory only: a restarted console
 * keeps its state but counts again from 0. `Changed` fires only when the state actually changes. Writes are atomic and
 * serialised; a failed write keeps the in-memory state and is retried on the next observation.
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

    public readonly Changed = new Signal<ConsoleRegistrationState>()
    private readonly writes = new SerialRuns()
    private state: ConsoleRegistrationState
    /** The state the file is known to hold; differs from `state` while a write is pending or has failed. */
    private persisted: ConsoleRegistrationState
    private streak = 0

    private constructor(private readonly filePath: string, state: ConsoleRegistrationState)
    {
        this.state = state
        this.persisted = state
    }

    /** Never throws and never writes: a missing, empty, unreadable or malformed file opens Registered. */
    public static async Open(path: string): Promise<ConsoleRegistration>
    {
        let text: string
        try
        {
            text = await readFile(path, ConsoleRegistration.Utf8)
        }
        catch
        {
            return new ConsoleRegistration(path, ConsoleRegistrationState.Registered)
        }
        return new ConsoleRegistration(path, ConsoleRegistration.StateIn(text))
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

    /** A throwing subscriber neither reaches the advert sender nor stops the state from being persisted. */
    private Emit(state: ConsoleRegistrationState): void
    {
        try
        {
            this.Changed.emit(state)
        }
        catch
        {
            // A subscriber's failure is its own; the registration has already changed.
        }
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
            catch
            {
                // Kept in memory; retried on the next observation.
            }
        })
    }
}
