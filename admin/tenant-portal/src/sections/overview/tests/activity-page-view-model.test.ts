import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TenantEventType } from '../../../tenant-types.js'
import { PageState } from '../../../shell/tenant-page-view-model.js'
import { FakeTenantApi, TenantTestHost, TestRail, Tick } from '../../../shell/tests/tenant-test-fixtures.js'
import { ActivityPageViewModel } from '../activity-page-view-model.js'
import { OverviewSectionService } from '../overview-section-service.js'

describe('Activity page', () =>
{
    it('opens over the Overview root, lists the session events newest first and follows new ones', async () =>
    {
        const host = new TenantTestHost(new FakeTenantApi())
        host.Provider.register(OverviewSectionService.Key, (p) => new OverviewSectionService(p))
        const rail = new TestRail(host.Provider)
        rail.Add(OverviewSectionService)
        const section = host.Provider.getRequired(OverviewSectionService.Key)
        section.OpenActivityCommand.Execute()
        await Tick.Settle()
        const page = host.Host.Content
        assert.ok(page instanceof ActivityPageViewModel)
        assert.equal(page.State, PageState.Empty)
        host.Session.RecordEvent({ type: TenantEventType.EnvironmentCreated, environmentName: 'alpha' })
        host.Session.RecordEvent({ type: TenantEventType.EnvironmentDeleted, environmentName: 'beta' })
        await Tick.Settle()
        assert.equal(page.State, PageState.Populated)
        assert.deepEqual(page.Rows.ToArray().map(r => r.Summary), ['Environment beta was deleted', 'Environment alpha was created'])
        assert.equal(page.Rows.ToArray()[0]?.WhenLabel, 'just now')
        section.OpenActivity()
        assert.equal(host.Host.Content, page)
        page.BackCommand.Execute()
        assert.notEqual(host.Host.Content, page)
    })
})
