import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TenantApiError } from '../../../tenant-api-client.js'
import { PageState } from '../../../shell/tenant-page-view-model.js'
import { FakeTenantApi, Inspect, TenantTestHost } from '../../../shell/tests/tenant-test-fixtures.js'
import { SettingsPageViewModel, SettingsTab } from '../settings-page-view-model.js'

class Fixture
{
    public static Api(): FakeTenantApi
    {
        const api = new FakeTenantApi().WithHive('hive-1', 'Example Hive')
        api.Hives[0]!.registry.endpoint = 'registry.example.test'
        api.ProfileDto = {
            ...TenantTestHost.Profile(TenantTestHost.AllCapabilities),
            idp: { baseUrl: 'https://idp.example.test', signingCaConfigured: true, adminTokenConfigured: false },
        }
        return api
    }

    public static async Page(api: FakeTenantApi): Promise<SettingsPageViewModel>
    {
        const page = new SettingsPageViewModel(new TenantTestHost(api).Session)
        await page.Refresh()
        return page
    }

    public static Pairs(page: SettingsPageViewModel, tab: SettingsTab): Array<[string, string]>
    {
        const rows = tab === SettingsTab.Hive ? page.HiveRows : tab === SettingsTab.Profile ? page.ProfileRows : page.IdpRows
        return rows.ToArray().map(r => [r.Key, r.Value])
    }
}

describe('SettingsPageViewModel', () =>
{
    it('has the four tabs, Hive & domain first, switched by label', async () =>
    {
        const page = await Fixture.Page(Fixture.Api())
        assert.deepEqual(page.TabLabels.ToArray(), ['Hive & domain', 'Tenant profile', 'Identity provider', 'Email domains'])
        assert.equal(page.SelectedTab, 'Hive & domain')
        assert.equal(page.IsHiveTab, true)
        page.SelectedTab = 'Identity provider'
        assert.equal(page.Tab, SettingsTab.IdentityProvider)
        assert.equal(page.IsIdentityProviderTab, true)
        assert.equal(page.IsHiveTab, false)
        page.SelectedTab = 'not a tab'
        assert.equal(page.Tab, SettingsTab.IdentityProvider)
        page.Tab = SettingsTab.Profile
        assert.equal(page.SelectedTab, 'Tenant profile')
        page.SelectedTab = 'Email domains'
        assert.equal(page.Tab, SettingsTab.EmailDomains)
        assert.equal(page.IsEmailDomainsTab, true)
        assert.equal(page.IsProfileTab, false)
    })

    it('loads the profile, the hives and the email domains', async () =>
    {
        const api = Fixture.Api()
        const page = await Fixture.Page(api)
        assert.equal(page.State, PageState.Populated)
        assert.deepEqual(api.Calls.map(c => c[0]), ['Profile', 'ListHives', 'GetEmailDomains'])
        assert.equal(page.EmailDomains.DomainsText, 'acme.test')
        assert.equal(page.EmailDomains.IsEditable, true)
    })

    it('hands the email-domains editor the settings capability of the profile', async () =>
    {
        const api = Fixture.Api()
        api.ProfileDto = TenantTestHost.Profile({ ...TenantTestHost.AllCapabilities, settings: false })
        const page = await Fixture.Page(api)
        assert.equal(page.EmailDomains.IsEditable, false)
        assert.equal(page.EmailDomains.ReadOnlyText, 'Only the tenant Owner can change the email domains.')
    })

    it('a 404 from the email-domain read leaves the tab read-only and the page populated', async () =>
    {
        const api = Fixture.Api()
        api.FailOn.set('GetEmailDomains', new TenantApiError(404, 'not found'))
        const page = await Fixture.Page(api)
        assert.equal(page.State, PageState.Populated)
        assert.equal(page.EmailDomains.IsEditable, false)
        assert.equal(page.EmailDomains.ReadOnlyText, 'Email domains are not available here.')
    })

    it('any other email-domain failure shows its sentence in the tab only', async () =>
    {
        const api = Fixture.Api()
        api.FailOn.set('GetEmailDomains', new TenantApiError(500, 'domains down'))
        const page = await Fixture.Page(api)
        assert.equal(page.State, PageState.Populated)
        assert.equal(page.ErrorText, '')
        assert.equal(page.EmailDomains.ErrorText, 'domains down')
        assert.equal(page.EmailDomains.IsEditable, false)
    })

    it('a 401 from the email-domain read expires the session', async () =>
    {
        const api = Fixture.Api()
        api.FailOn.set('GetEmailDomains', new TenantApiError(401, 'gone'))
        const host = new TenantTestHost(api)
        await new SettingsPageViewModel(host.Session).Refresh()
        assert.equal(host.Reloader.Count, 1)
    })

    it('shows the hive and domain fields the server reports', async () =>
    {
        const page = await Fixture.Page(Fixture.Api())
        assert.equal(page.HasHive, true)
        assert.deepEqual(Fixture.Pairs(page, SettingsTab.Hive), [
            ['Hive name', 'Example Hive'],
            ['Cluster backend', 'aks'],
            ['Cluster mode', 'attach'],
            ['Registry mode', 'pull'],
            ['Registry endpoint', 'registry.example.test'],
            ['Created', '2026-01-01 00:00 UTC'],
        ])
    })

    it('says so when there is no hive, and leaves out an unset registry endpoint', async () =>
    {
        const none = Fixture.Api()
        none.Hives = []
        const page = await Fixture.Page(none)
        assert.equal(page.HasNoHive, true)
        assert.equal(page.HiveRows.Count, 0)
        const noEndpoint = Fixture.Api()
        noEndpoint.Hives[0]!.registry.endpoint = undefined
        const other = await Fixture.Page(noEndpoint)
        assert.equal(Fixture.Pairs(other, SettingsTab.Hive).some(([k]) => k === 'Registry endpoint'), false)
    })

    it('shows only the profile fields that are set', async () =>
    {
        const page = await Fixture.Page(Fixture.Api())
        assert.deepEqual(Fixture.Pairs(page, SettingsTab.Profile), [
            ['Tenant name', 'Example Tenant'],
            ['Tenant id', 'tenant-1'],
            ['Organisation', 'Example Org'],
            ['Owner contact', 'owner@example.test'],
            ['Your role', 'Tenant owner'],
            ['Hive', 'Example Hive'],
        ])
        const sparse = Fixture.Api()
        sparse.ProfileDto = {
            principalId: 'p', roleLabel: 'Viewer', environment: { id: 't', displayName: 'T' },
            capabilities: TenantTestHost.AllCapabilities,
        }
        const other = await Fixture.Page(sparse)
        assert.deepEqual(Fixture.Pairs(other, SettingsTab.Profile), [['Tenant name', 'T'], ['Tenant id', 't'], ['Your role', 'Viewer']])
    })

    it('shows the identity provider by reference only', async () =>
    {
        const page = await Fixture.Page(Fixture.Api())
        assert.equal(page.HasIdp, true)
        assert.deepEqual(Fixture.Pairs(page, SettingsTab.IdentityProvider), [
            ['Base URL', 'https://idp.example.test'],
            ['Signing CA', 'Configured'],
            ['Admin token', 'Not configured'],
        ])
        const noUrl = Fixture.Api()
        noUrl.ProfileDto!.idp = { signingCaConfigured: false, adminTokenConfigured: true }
        const other = await Fixture.Page(noUrl)
        assert.deepEqual(Fixture.Pairs(other, SettingsTab.IdentityProvider)[0], ['Base URL', 'No base URL set.'])
    })

    it('says so when no identity provider is configured', async () =>
    {
        const api = Fixture.Api()
        api.ProfileDto!.idp = undefined
        const page = await Fixture.Page(api)
        assert.equal(page.HasNoIdp, true)
        assert.equal(page.IdpRows.Count, 0)
    })

    it('the page itself exposes no command; only the Email domains editor edits', async () =>
    {
        const page = await Fixture.Page(Fixture.Api())
        assert.equal(Inspect.PropertyValues(page).some(v => typeof v === 'object' && v !== null && 'Execute' in v), false)
    })

    it('is Denied on a 403, Error on another failure, and a 401 expires the session', async () =>
    {
        const denied = Fixture.Api()
        denied.FailOn.set('Profile', new TenantApiError(403, 'forbidden'))
        assert.equal((await Fixture.Page(denied)).State, PageState.Denied)
        const failed = Fixture.Api()
        failed.FailOn.set('ListHives', new TenantApiError(500, 'hives down'))
        const page = await Fixture.Page(failed)
        assert.equal(page.State, PageState.Error)
        assert.equal(page.ErrorText, 'hives down')
        const expired = Fixture.Api()
        expired.FailOn.set('Profile', new TenantApiError(401, 'gone'))
        const host = new TenantTestHost(expired)
        await new SettingsPageViewModel(host.Session).Refresh()
        assert.equal(host.Reloader.Count, 1)
    })
})
