import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AdvertOutcome, AdvertTrigger, ConsoleRegistration, ConsoleRegistrationState } from '../console-registration.js'

class Names
{
    public static readonly TempPrefix = 'console-registration-'
    public static readonly Utf8 = 'utf8'
    public static readonly Empty = ''
    public static readonly NotJson = '{not json'
    public static readonly ArrayBody = '[]'
    public static readonly NullBody = 'null'
    public static readonly UnknownState = '{"state":"bogus"}'
    public static readonly NumberState = '{"state":5}'
    public static readonly RefusedFile = '{"state":"refused"}'
    public static readonly BlockedDir = 'blocked'
    public static readonly SubscriberFailure = 'subscriber'
    public static readonly FileName = 'console-registration.json'
    public static readonly WriteFailedPrefix = '[console-registration] state not saved: '
    public static readonly ListenerFailedPrefix = '[console-registration] a Changed listener failed: '
    public static readonly TypeErrorName = 'TypeError'
    public static readonly ErrorNamePattern = /^[A-Za-z]+$/
    public static readonly RefusedError = 'console-not-registered'
    public static readonly RefusedMessage = 'This console is no longer registered with the platform. Ask your administrator.'
}

describe('ConsoleRegistration', () =>
{
    let root = ''
    let path = ''

    const observeAll = async (registration: ConsoleRegistration, steps: Array<[AdvertOutcome, AdvertTrigger]>): Promise<void> =>
    {
        for (const [outcome, trigger] of steps)
        {
            await registration.Observe(outcome, trigger)
        }
    }

    const record = (registration: ConsoleRegistration): ConsoleRegistrationState[] =>
    {
        const seen: ConsoleRegistrationState[] = []
        registration.Changed.subscribe(s => seen.push(s))
        return seen
    }

    beforeEach(() =>
    {
        root = mkdtempSync(join(tmpdir(), Names.TempPrefix))
        path = join(root, ConsoleRegistration.FileName)
    })

    afterEach(() =>
    {
        rmSync(root, { recursive: true, force: true })
    })

    it('opens Registered with no file, an empty file or a malformed one', async () =>
    {
        const missing = await ConsoleRegistration.Open(path)
        assert.equal(missing.State, ConsoleRegistrationState.Registered)
        assert.equal(missing.IsRefused, false)
        for (const text of [Names.Empty, Names.NotJson, Names.ArrayBody, Names.NullBody, Names.UnknownState, Names.NumberState])
        {
            writeFileSync(path, text, Names.Utf8)
            const opened = await ConsoleRegistration.Open(path)
            assert.equal(opened.State, ConsoleRegistrationState.Registered, JSON.stringify(text))
        }
        rmSync(path)
        mkdirSync(path)
        assert.equal((await ConsoleRegistration.Open(path)).State, ConsoleRegistrationState.Registered, 'an unreadable path')
    })

    it('OpenRegistered opens Registered over a saved Refused file without reading or writing it', () =>
    {
        writeFileSync(path, Names.RefusedFile, Names.Utf8)
        const opened = ConsoleRegistration.OpenRegistered(path)
        assert.equal(opened.State, ConsoleRegistrationState.Registered)
        assert.equal(opened.IsRefused, false)
        assert.equal(readFileSync(path, Names.Utf8), Names.RefusedFile)
    })

    it('two consecutive timer refusals make it Refused, signalled once and persisted', async () =>
    {
        const registration = await ConsoleRegistration.Open(path)
        const seen = record(registration)
        await registration.Observe(AdvertOutcome.Refused, AdvertTrigger.Timer)
        assert.equal(registration.State, ConsoleRegistrationState.Registered, 'one refusal is not enough')
        assert.deepEqual(seen, [])
        await registration.Observe(AdvertOutcome.Refused, AdvertTrigger.Timer)
        assert.equal(registration.State, ConsoleRegistrationState.Refused)
        assert.equal(registration.IsRefused, true)
        assert.deepEqual(seen, [ConsoleRegistrationState.Refused])
        await registration.Observe(AdvertOutcome.Refused, AdvertTrigger.Timer)
        assert.deepEqual(seen, [ConsoleRegistrationState.Refused], 'a further refusal changes nothing, so nothing is signalled')
        assert.deepEqual(JSON.parse(readFileSync(path, Names.Utf8)), { state: ConsoleRegistrationState.Refused })
        assert.equal((await ConsoleRegistration.Open(path)).State, ConsoleRegistrationState.Refused)
    })

    it('a transient timer answer between two timer refusals resets the streak', async () =>
    {
        const registration = await ConsoleRegistration.Open(path)
        await observeAll(registration, [
            [AdvertOutcome.Refused, AdvertTrigger.Timer],
            [AdvertOutcome.Transient, AdvertTrigger.Timer],
            [AdvertOutcome.Refused, AdvertTrigger.Timer],
        ])
        assert.equal(registration.State, ConsoleRegistrationState.Registered)
    })

    it('a transient answer never changes a Refused state', async () =>
    {
        writeFileSync(path, Names.RefusedFile, Names.Utf8)
        const registration = await ConsoleRegistration.Open(path)
        const seen = record(registration)
        for (const trigger of [AdvertTrigger.Start, AdvertTrigger.Timer, AdvertTrigger.Change])
        {
            await registration.Observe(AdvertOutcome.Transient, trigger)
        }
        assert.equal(registration.State, ConsoleRegistrationState.Refused)
        assert.deepEqual(seen, [])
    })

    it('Start and Change refusals neither count nor break a streak', async () =>
    {
        const mixed = await ConsoleRegistration.Open(path)
        await observeAll(mixed, [
            [AdvertOutcome.Refused, AdvertTrigger.Timer],
            [AdvertOutcome.Refused, AdvertTrigger.Change],
            [AdvertOutcome.Refused, AdvertTrigger.Timer],
        ])
        assert.equal(mixed.State, ConsoleRegistrationState.Refused)
        for (const trigger of [AdvertTrigger.Change, AdvertTrigger.Start])
        {
            rmSync(path, { force: true })
            const registration = await ConsoleRegistration.Open(path)
            await observeAll(registration, [
                [AdvertOutcome.Refused, trigger],
                [AdvertOutcome.Refused, trigger],
                [AdvertOutcome.Refused, trigger],
            ])
            assert.equal(registration.State, ConsoleRegistrationState.Registered, AdvertTrigger[trigger])
        }
    })

    it('a restarted console keeps its state but starts its streak at 0', async () =>
    {
        const first = await ConsoleRegistration.Open(path)
        await first.Observe(AdvertOutcome.Refused, AdvertTrigger.Timer)
        const second = await ConsoleRegistration.Open(path)
        await second.Observe(AdvertOutcome.Refused, AdvertTrigger.Timer)
        assert.equal(second.State, ConsoleRegistrationState.Registered, 'the streak is not persisted')
    })

    it('any accepted answer restores Registered, signalled and persisted', async () =>
    {
        writeFileSync(path, Names.RefusedFile, Names.Utf8)
        const registration = await ConsoleRegistration.Open(path)
        assert.equal(registration.State, ConsoleRegistrationState.Refused)
        const seen = record(registration)
        await registration.Observe(AdvertOutcome.Accepted, AdvertTrigger.Change)
        assert.equal(registration.State, ConsoleRegistrationState.Registered)
        assert.equal(registration.IsRefused, false)
        assert.deepEqual(seen, [ConsoleRegistrationState.Registered])
        assert.equal((await ConsoleRegistration.Open(path)).State, ConsoleRegistrationState.Registered)
    })

    it('an accepted answer resets the streak', async () =>
    {
        const registration = await ConsoleRegistration.Open(path)
        await observeAll(registration, [
            [AdvertOutcome.Refused, AdvertTrigger.Timer],
            [AdvertOutcome.Accepted, AdvertTrigger.Start],
            [AdvertOutcome.Refused, AdvertTrigger.Timer],
        ])
        assert.equal(registration.State, ConsoleRegistrationState.Registered)
    })

    it('a failed write keeps the in-memory state, never rejects, and is retried on the next change', async () =>
    {
        const blocked = join(root, Names.BlockedDir)
        mkdirSync(blocked)
        const target = join(blocked, ConsoleRegistration.FileName)
        mkdirSync(target)
        const lines: string[] = []
        const registration = await ConsoleRegistration.Open(target, line => lines.push(line))
        const seen = record(registration)
        await registration.Observe(AdvertOutcome.Refused, AdvertTrigger.Timer)
        await registration.Observe(AdvertOutcome.Refused, AdvertTrigger.Timer)
        assert.equal(registration.State, ConsoleRegistrationState.Refused, 'the write failed (the path is a directory) but the state holds')
        assert.deepEqual(seen, [ConsoleRegistrationState.Refused])
        assert.equal(lines.length, 1, 'the failed write is logged once')
        assert.ok(lines[0].startsWith(Names.WriteFailedPrefix), lines[0])
        assert.match(lines[0].slice(Names.WriteFailedPrefix.length), Names.ErrorNamePattern, 'the error name only')
        assert.ok(!lines[0].includes(Names.BlockedDir), 'never the path')
        rmSync(target, { recursive: true })
        await registration.Observe(AdvertOutcome.Refused, AdvertTrigger.Timer)
        assert.deepEqual(JSON.parse(readFileSync(target, Names.Utf8)), { state: ConsoleRegistrationState.Refused }, 'the next observation writes it')
        assert.equal(lines.length, 1, 'a successful retry logs nothing')
    })

    it('a throwing Changed subscriber is logged by name and the subscribers after it are still told', async () =>
    {
        const lines: string[] = []
        const registration = await ConsoleRegistration.Open(path, line => lines.push(line))
        registration.Changed.subscribe(() => { throw new TypeError(Names.SubscriberFailure) })
        const seen = record(registration)
        await observeAll(registration, [
            [AdvertOutcome.Refused, AdvertTrigger.Timer],
            [AdvertOutcome.Refused, AdvertTrigger.Timer],
        ])
        assert.equal(registration.State, ConsoleRegistrationState.Refused)
        assert.deepEqual(seen, [ConsoleRegistrationState.Refused], 'the second subscriber was told')
        assert.deepEqual(lines, [Names.ListenerFailedPrefix + Names.TypeErrorName])
        assert.equal((await ConsoleRegistration.Open(path)).State, ConsoleRegistrationState.Refused, 'the state was still persisted')
    })

    it('a disposed subscription is no longer told', async () =>
    {
        const registration = await ConsoleRegistration.Open(path)
        const seen: ConsoleRegistrationState[] = []
        const subscription = registration.Changed.subscribe(s => seen.push(s))
        assert.equal(registration.Changed.subscriberCount, 1)
        subscription.dispose()
        assert.equal(registration.Changed.subscriberCount, 0)
        await registration.Observe(AdvertOutcome.Refused, AdvertTrigger.Timer)
        await registration.Observe(AdvertOutcome.Refused, AdvertTrigger.Timer)
        assert.deepEqual(seen, [])
    })

    it('RefusedBody is the fixed body', () =>
    {
        assert.deepEqual(ConsoleRegistration.RefusedBody, { error: Names.RefusedError, message: Names.RefusedMessage })
        assert.equal(ConsoleRegistration.RefusedError, Names.RefusedError)
        assert.equal(ConsoleRegistration.RefusedMessage, Names.RefusedMessage)
        assert.equal(ConsoleRegistration.FileName, Names.FileName)
        assert.equal(ConsoleRegistration.RefusalThreshold, 2)
        assert.ok(Object.isFrozen(ConsoleRegistration.RefusedBody))
    })
})
