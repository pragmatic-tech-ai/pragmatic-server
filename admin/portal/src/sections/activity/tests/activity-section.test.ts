import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PageState } from '../../../shell/portal-page-view-model.js'
import { FakeControlPlane, PortalTestHost, Tick } from '../../../shell/tests/portal-test-fixtures.js'
import { ActivityEntryPageViewModel } from '../activity-entry-page-view-model.js'
import { ActivityPageViewModel } from '../activity-page-view-model.js'
import { ActivitySectionService } from '../activity-section-service.js'

// An Activity section over a fake control plane.
class ActivityFixture
{
    public readonly Api = new FakeControlPlane()
    public readonly Host: PortalTestHost
    public readonly Section: ActivitySectionService

    public constructor()
    {
        this.Api.Activity = [
            { id: 'a2', actor: 'op@example.test', method: 'POST', path: '/api/manifests/1.4.0/withdrawn', status: 200, at: '2026-10-20T09:15:00.000Z' },
            { id: 'a1', actor: 'lead@example.test', method: 'DELETE', path: '/api/tenants/acme-prod', status: 409, at: '2026-10-19T17:02:00.000Z' },
        ]
        this.Host = new PortalTestHost(this.Api.AsClient())
        this.Section = new ActivitySectionService(this.Host.Provider)
    }

    public get Content(): unknown
    {
        return this.Host.Host.Content
    }

    public async List(): Promise<ActivityPageViewModel>
    {
        this.Section.OnActivated()
        await Tick.Settle()
        assert.ok(this.Content instanceof ActivityPageViewModel)
        return this.Content
    }
}

describe('Activity section', () =>
{
    it('the audit list shows when, who, what and the outcome of each entry', async () =>
    {
        const fx = new ActivityFixture()
        const list = await fx.List()
        assert.equal(list.State, PageState.Populated)
        assert.deepEqual(list.Rows.ToArray().map(r => [r.WhenLabel, r.Actor, r.ActionLabel, r.OutcomeLabel]), [
            ['2026-10-20 09:15', 'op@example.test', 'Withdrew a version', 'Succeeded'],
            ['2026-10-19 17:02', 'lead@example.test', 'Deleted a tenant', 'Refused (409)'],
        ])
    })

    it('list -> entry detail with the request it records; Back returns', async () =>
    {
        const fx = new ActivityFixture()
        const list = await fx.List()
        list.Rows.Get(1)?.OpenCommand.Execute()
        await Tick.Settle()
        const entry = fx.Content
        assert.ok(entry instanceof ActivityEntryPageViewModel)
        assert.equal(entry.State, PageState.Populated)
        assert.equal(entry.ActionLabel, 'Deleted a tenant')
        assert.equal(entry.Actor, 'lead@example.test')
        assert.equal(entry.WhenLabel, '2026-10-19 17:02')
        assert.equal(entry.Method, 'DELETE')
        assert.equal(entry.Path, '/api/tenants/acme-prod')
        assert.equal(entry.StatusText, '409')
        assert.equal(entry.OutcomeLabel, 'Refused (409)')
        assert.equal(entry.BackCommand.CanExecute(), true)
        entry.BackCommand.Execute()
        assert.equal(fx.Content, list)
    })

    it('an entry with a note shows it (e.g. what a hive delete kept); one without shows none', async () =>
    {
        const fx = new ActivityFixture()
        fx.Api.Activity = [
            { id: 'a3', actor: 'op@example.test', method: 'DELETE', path: '/api/hives/h1', status: 200, at: '2026-11-03T09:15:00.000Z', note: 'retained: pragmatic-tenant-admin-t1-data, pragmatic-tenant-admin-t1-seed' },
            { id: 'a2', actor: 'op@example.test', method: 'DELETE', path: '/api/hives/h2', status: 200, at: '2026-11-03T09:10:00.000Z' },
        ]
        const list = await fx.List()
        list.Rows.Get(0)?.OpenCommand.Execute()
        await Tick.Settle()
        const withNote = fx.Content
        assert.ok(withNote instanceof ActivityEntryPageViewModel)
        assert.equal(withNote.Note, 'retained: pragmatic-tenant-admin-t1-data, pragmatic-tenant-admin-t1-seed')
        assert.equal(withNote.HasNote, true)
        fx.Section.BackCommand.Execute()
        list.Rows.Get(1)?.OpenCommand.Execute()
        await Tick.Settle()
        const without = fx.Content
        assert.ok(without instanceof ActivityEntryPageViewModel)
        assert.equal(without.Note, '')
        assert.equal(without.HasNote, false)
    })

    it('no entries -> Empty', async () =>
    {
        const fx = new ActivityFixture()
        fx.Api.Activity = []
        const list = await fx.List()
        assert.equal(list.State, PageState.Empty)
        assert.equal(list.Rows.Count, 0)
    })

    it('a server failure is reported as Failed', async () =>
    {
        const fx = new ActivityFixture()
        fx.Api.Activity = [{ id: 'a3', actor: 'op@example.test', method: 'POST', path: '/api/provision', status: 502, at: '2026-10-21T00:00:00.000Z' }]
        const list = await fx.List()
        assert.equal(list.Rows.Get(0)?.ActionLabel, 'Provisioned')
        assert.equal(list.Rows.Get(0)?.OutcomeLabel, 'Failed (502)')
    })
})
