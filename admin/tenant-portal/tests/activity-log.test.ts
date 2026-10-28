import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ActivityEntry, ActivityLog } from '../src/activity-log.js'
import { PillKind } from '../src/kit/pill-kinds.js'
import { TenantEventType } from '../src/tenant-types.js'

class Clock
{
    public Now = 1000

    public Read = (): number => this.Now
}

describe('ActivityLog', () =>
{
    it('records newest-first and stamps client time', () =>
    {
        const clock = new Clock()
        const log = new ActivityLog(200, clock.Read)
        log.Record({ type: TenantEventType.EnvironmentCreated, environmentName: 'a' })
        clock.Now = 2000
        log.Record({ type: TenantEventType.EnvironmentDeleted, environmentName: 'b' })
        assert.equal(log.Count, 2)
        assert.deepEqual(log.Entries.map(e => e.EnvironmentName), ['b', 'a'])
        assert.equal(log.Entries[0].ObservedAt, 2000)
        assert.equal(log.Entries[1].ObservedAt, 1000)
    })

    it('drops the oldest past the cap', () =>
    {
        const log = new ActivityLog(3)
        for (const n of ['a', 'b', 'c', 'd', 'e'])
        {
            log.Record({ type: TenantEventType.EnvironmentChanged, environmentName: n })
        }
        assert.equal(log.Count, 3)
        assert.deepEqual(log.Entries.map(e => e.EnvironmentName), ['e', 'd', 'c'])
    })

    it('EntriesFor filters by environment', () =>
    {
        const log = new ActivityLog()
        log.Record({ type: TenantEventType.EnvironmentCreated, environmentName: 'a' })
        log.Record({ type: TenantEventType.EnvironmentCreated, environmentName: 'b' })
        log.Record({ type: TenantEventType.HealthChanged, environmentName: 'a' })
        const only = log.EntriesFor('a')
        assert.equal(only.length, 2)
        assert.ok(only.every(e => e.EnvironmentName === 'a'))
    })

    it('raises EntriesProperty on Record', () =>
    {
        const log = new ActivityLog()
        const seen: string[] = []
        log.PropertyChanged(ActivityLog.EntriesProperty).subscribe(e => { seen.push(e.property) })
        log.Record({ type: TenantEventType.EnvironmentCreated, environmentName: 'a' })
        assert.deepEqual(seen, [ActivityLog.EntriesProperty])
    })
})

describe('ActivityEntry', () =>
{
    it('summarises per event type', () =>
    {
        assert.equal(new ActivityEntry(TenantEventType.EnvironmentCreated, 'x', 0).Summary, 'Environment x was created')
        assert.equal(new ActivityEntry(TenantEventType.EnvironmentChanged, 'x', 0).Summary, 'Environment x was updated')
        assert.equal(new ActivityEntry(TenantEventType.EnvironmentDeleted, 'x', 0).Summary, 'Environment x was deleted')
        assert.equal(new ActivityEntry(TenantEventType.HealthChanged, 'x', 0).Summary, 'Health changed for x')
    })

    it('uses the Observed pill', () =>
    {
        assert.equal(new ActivityEntry(TenantEventType.HealthChanged, 'x', 0).Pill, PillKind.Observed)
    })

    it('formats relative time deterministically', () =>
    {
        const e = new ActivityEntry(TenantEventType.HealthChanged, 'x', 1000)
        assert.equal(e.RelativeTime(() => 1000), 'just now')
        assert.equal(e.RelativeTime(() => 1000 + 59_000), 'just now')
        assert.equal(e.RelativeTime(() => 1000 + 60_000), '1m ago')
        assert.equal(e.RelativeTime(() => 1000 + 5 * 60_000), '5m ago')
        assert.equal(e.RelativeTime(() => 1000 + 60 * 60_000), '1h ago')
        assert.equal(e.RelativeTime(() => 1000 + 3 * 3_600_000), '3h ago')
    })
})
