import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TenantApiError } from '../../../tenant-api-client.js'
import { PageState } from '../../../shell/tenant-page-view-model.js'
import { FakeTenantApi, TenantTestHost } from '../../../shell/tests/tenant-test-fixtures.js'
import { ConnectionPageViewModel } from '../connection-page-view-model.js'

describe('ConnectionPageViewModel', () =>
{
    it('shows Connected with the target and what each environment runs', async () =>
    {
        const api = new FakeTenantApi().WithEnvironment('alpha', undefined, 'hive-1', 'registry/app:2')
        api.Rollout.targetVersion = '2'
        const page = new ConnectionPageViewModel(new TenantTestHost(api).Session)
        await page.Refresh()
        assert.equal(page.State, PageState.Populated)
        assert.equal(page.IsConnected, true)
        assert.equal(page.StatusLabel, 'Connected')
        assert.equal(page.TargetVersionText, 'Target version: 2')
        assert.equal(page.Rows.Count, 1)
        assert.equal(page.Rows.ToArray()[0]?.HealthLabel, 'Healthy')
        assert.deepEqual(api.Calls.find(c => c[0] === 'GetRollout'), ['GetRollout', 'hive-1'])
    })

    it('reports a quiet link (503) as a state, not an error', async () =>
    {
        const api = new FakeTenantApi()
        api.FailOn.set('GetRollout', new TenantApiError(503, 'unavailable'))
        const page = new ConnectionPageViewModel(new TenantTestHost(api).Session)
        await page.Refresh()
        assert.equal(page.State, PageState.Populated)
        assert.equal(page.IsQuiet, true)
        assert.equal(page.HasRows, false)
        assert.equal(page.NoRowsText, 'Running versions are unavailable while the link is quiet.')
    })

    it('is Empty without a hive and Denied on 403', async () =>
    {
        const api = new FakeTenantApi()
        const page = new ConnectionPageViewModel(new TenantTestHost(api, null).Session)
        await page.Refresh()
        assert.equal(page.State, PageState.Empty)
        const denied = new FakeTenantApi()
        denied.FailOn.set('GetRollout', new TenantApiError(403, 'forbidden'))
        const deniedPage = new ConnectionPageViewModel(new TenantTestHost(denied).Session)
        await deniedPage.Refresh()
        assert.equal(deniedPage.State, PageState.Denied)
    })
})
