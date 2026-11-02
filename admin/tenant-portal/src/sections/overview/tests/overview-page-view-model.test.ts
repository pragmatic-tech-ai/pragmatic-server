import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { NavigationService } from '@pragmatic-tech-ai/mural/framework/shell/services/navigation-service.js'
import { TenantApiError } from '../../../tenant-api-client.js'
import { EnvStatus, TenantEventType } from '../../../tenant-types.js'
import { PageState } from '../../../shell/tenant-page-view-model.js'
import { FakeTenantApi, Tick } from '../../../shell/tests/tenant-test-fixtures.js'
import { ConnectionSectionService } from '../../connection/connection-section-service.js'
import { CreateEnvironmentDialogViewModel } from '../../environments/create-environment-dialog-view-model.js'
import { EnvironmentDetailPageViewModel } from '../../environments/environment-detail-page-view-model.js'
import { EnvironmentsSectionService } from '../../environments/environments-section-service.js'
import { SectionsFixture } from '../../environments/tests/sections-fixture.js'
import { ActivityPageViewModel } from '../activity-page-view-model.js'
import { OverviewSectionService } from '../overview-section-service.js'
import { OverviewConnectionState, OverviewPageViewModel } from '../overview-page-view-model.js'

class Home
{
    public static async Open(f: SectionsFixture): Promise<OverviewPageViewModel>
    {
        f.Rail.Select(OverviewSectionService)
        await Tick.Settle()
        const page = f.Content
        assert.ok(page instanceof OverviewPageViewModel)
        return page
    }

    // Two environments on version 1 with versions 1 and 2 published.
    public static Api(): FakeTenantApi
    {
        return new FakeTenantApi()
            .WithEnvironment('alpha', EnvStatus.Running, 'hive-1', 'registry/app:1')
            .WithEnvironment('beta', EnvStatus.Stopped, 'hive-1', 'registry/app:1')
            .WithManifest('1', 'registry/app:1')
            .WithManifest('2', 'registry/app:2')
    }

    public static ActiveService(f: SectionsFixture): unknown
    {
        return f.Host.Provider.getRequired(NavigationService.Key).ActiveService
    }
}

describe('Overview page', () =>
{
    it('shows a card per environment, the offer, and a connected hive', async () =>
    {
        const f = new SectionsFixture(Home.Api())
        const page = await Home.Open(f)
        assert.equal(page.State, PageState.Populated)
        assert.equal(page.Subtitle, 'Everything running in your hive, Example Hive, for the Example Tenant tenant.')
        const [alpha, beta] = page.Cards.ToArray()
        assert.equal(alpha?.Name, 'alpha')
        assert.equal(alpha?.StatusPill.Label, 'Running')
        assert.equal(alpha?.HealthPill.Label, 'Healthy')
        assert.equal(alpha?.Version, '1')
        assert.equal(alpha?.UrlText, 'https://alpha.example.test')
        assert.equal(beta?.UrlText, 'Not serving')
        assert.equal(page.HasOffer, true)
        assert.equal(page.OfferVersion, '2')
        assert.equal(page.OfferTitle, 'Version 2 is available.')
        assert.equal(page.OfferBody, '2 of 2 environments are on an earlier version. Nothing changes until you choose to adopt.')
        assert.equal(page.Connection, OverviewConnectionState.Connected)
        assert.equal(page.ConnectionLabel, 'Connected')
    })

    it('offers nothing when the hive targets the newest version and every environment runs it', async () =>
    {
        const api = new FakeTenantApi().WithEnvironment('alpha', EnvStatus.Running, 'hive-1', 'registry/app:2')
            .WithManifest('1', 'registry/app:1').WithManifest('2', 'registry/app:2')
        api.Rollout.targetVersion = '2'
        const page = await Home.Open(new SectionsFixture(api))
        assert.equal(page.HasOffer, false)
    })

    it('never offers a withdrawn version', async () =>
    {
        const api = new FakeTenantApi().WithEnvironment('alpha', EnvStatus.Running, 'hive-1', 'registry/app:1')
            .WithManifest('1', 'registry/app:1').WithManifest('2', 'registry/app:2', { withdrawn: true })
        const page = await Home.Open(new SectionsFixture(api))
        assert.equal(page.HasOffer, false)
    })

    it('degrades failed health, versions and rollout reads instead of failing', async () =>
    {
        const api = Home.Api()
        api.FailOn.set('GetHealth', new TenantApiError(500, 'down'))
        api.FailOn.set('ListManifests', new TenantApiError(500, 'down'))
        api.FailOn.set('GetRollout', new TenantApiError(500, 'down'))
        const page = await Home.Open(new SectionsFixture(api))
        assert.equal(page.State, PageState.Populated)
        assert.equal(page.Cards.Count, 2)
        assert.equal(page.Cards.ToArray()[0]?.HealthPill.Label, 'Unknown')
        assert.equal(page.HasOffer, false)
        assert.equal(page.Connection, OverviewConnectionState.Unavailable)
        assert.equal(page.ConnectionText, 'Could not load the connection status.')
    })

    it('reads a 503 rollout as a quiet link and a 403 as not available', async () =>
    {
        const quiet = Home.Api()
        quiet.FailOn.set('GetRollout', new TenantApiError(503, 'unavailable'))
        const quietPage = await Home.Open(new SectionsFixture(quiet))
        assert.equal(quietPage.IsQuiet, true)
        assert.equal(quietPage.ConnectionLabel, 'Quiet')

        const forbidden = Home.Api()
        forbidden.FailOn.set('GetRollout', new TenantApiError(403, 'forbidden'))
        const forbiddenPage = await Home.Open(new SectionsFixture(forbidden))
        assert.equal(forbiddenPage.Connection, OverviewConnectionState.Forbidden)
        assert.equal(forbiddenPage.HasConnectionPill, false)
    })

    it('still shows the environments without a hive, omitting what needs one', async () =>
    {
        const api = new FakeTenantApi().WithEnvironment('alpha')
        const page = await Home.Open(new SectionsFixture(api, null))
        assert.equal(page.State, PageState.Populated)
        assert.equal(page.Cards.Count, 1)
        assert.equal(page.Connection, OverviewConnectionState.NoHive)
        assert.equal(page.HasOffer, false)
        assert.equal(api.Count('GetRollout'), 0)
    })

    it('is an Error only when the environments fail, still populated without any, and expires on a 401 anywhere', async () =>
    {
        const failing = Home.Api()
        failing.FailOn.set('ListEnvironments', new TenantApiError(500, 'boom'))
        const failed = await Home.Open(new SectionsFixture(failing))
        assert.equal(failed.State, PageState.Error)
        assert.equal(failed.ErrorText, 'boom')

        // No environments: the connection card, offer and activity still show.
        const empty = await Home.Open(new SectionsFixture(new FakeTenantApi()))
        assert.equal(empty.State, PageState.Populated)
        assert.equal(empty.HasNoEnvironments, true)

        const expiring = Home.Api()
        expiring.FailOn.set('GetHealth', new TenantApiError(401, 'gone'))
        const f = new SectionsFixture(expiring)
        await Home.Open(f)
        assert.equal(f.Host.Reloader.Count, 1)
    })

    it('stops following activity once its root is rebuilt (the boot restarts the first section)', async () =>
    {
        const f = new SectionsFixture(Home.Api())
        const first = await Home.Open(f)
        f.Overview.Restart()
        await Tick.Settle()
        const second = f.Content
        assert.ok(second instanceof OverviewPageViewModel)
        assert.notEqual(second, first)
        f.Host.Session.RecordEvent({ type: TenantEventType.EnvironmentChanged, environmentName: 'alpha' })
        assert.equal(first.RecentActivity.Count, 0)
        assert.equal(second.RecentActivity.Count, 1)
    })

    it("opens an environment's detail in Environments from its card", async () =>
    {
        const f = new SectionsFixture(Home.Api())
        const page = await Home.Open(f)
        page.Cards.ToArray()[1]!.OpenCommand.Execute()
        await Tick.Settle()
        const detail = f.Content
        assert.ok(detail instanceof EnvironmentDetailPageViewModel)
        assert.equal(detail.Name, 'beta')
        assert.equal(detail.State, PageState.Populated)
        assert.equal(Home.ActiveService(f), f.Environments)
        detail.BackCommand.Execute()
        assert.equal(f.Content?.constructor.name, 'EnvironmentsPageViewModel')
    })

    it('creates an environment and opens it in Environments; disabled without the permission', async () =>
    {
        const api = Home.Api()
        const f = new SectionsFixture(api)
        const page = await Home.Open(f)
        page.CreateCommand.Execute()
        await Tick.Settle()
        const dialog = f.Dialogs.Last
        assert.ok(dialog instanceof CreateEnvironmentDialogViewModel)
        dialog.Name = 'alpha'
        assert.equal(dialog.NameErrorText, 'An environment with this name exists.')
        dialog.Name = 'gamma'
        await dialog.Confirm()
        await Tick.Settle()
        const detail = f.Content
        assert.ok(detail instanceof EnvironmentDetailPageViewModel)
        assert.equal(detail.Name, 'gamma')
        assert.equal(Home.ActiveService(f), f.Environments)

        const denied = new SectionsFixture(Home.Api(), { envs: false, adopt: true, access: true, settings: true })
        const deniedPage = await Home.Open(denied)
        assert.equal(deniedPage.CreateCommand.CanExecute(), false)
        assert.equal(deniedPage.DeniedReason, 'Needs the Manage environments permission. Ask owner@example.test.')
        deniedPage.CreateCommand.Execute()
        await Tick.Settle()
        assert.equal(denied.Dialogs.Shown.length, 0)
    })

    it('reviews the offer in Releases, disabled without the Adopt permission', async () =>
    {
        const f = new SectionsFixture(Home.Api())
        const page = await Home.Open(f)
        page.ReviewAdoptCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(f.Releases.Adopted, ['2'])

        const denied = new SectionsFixture(Home.Api(), { envs: true, adopt: false, access: true, settings: true })
        const deniedPage = await Home.Open(denied)
        assert.equal(deniedPage.ReviewAdoptCommand.CanExecute(), false)
        deniedPage.ReviewAdoptCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(denied.Releases.Adopted, [])
        assert.equal(deniedPage.AdoptDeniedReason, 'Needs the Adopt versions permission. Ask owner@example.test.')
    })

    it('follows the latest five events and opens the full activity', async () =>
    {
        const f = new SectionsFixture(Home.Api())
        const page = await Home.Open(f)
        assert.equal(page.HasRecentActivity, false)
        for (let i = 0; i < 7; i++)
        {
            f.Host.Session.RecordEvent({ type: TenantEventType.EnvironmentChanged, environmentName: 'env' + i })
        }
        assert.equal(page.RecentActivity.Count, OverviewPageViewModel.RecentActivityCount)
        assert.equal(page.RecentActivity.ToArray()[0]?.Summary, 'Environment env6 was updated')
        page.SeeAllActivityCommand.Execute()
        await Tick.Settle()
        assert.ok(f.Content instanceof ActivityPageViewModel)
    })

    it('brings Connection status to the front', async () =>
    {
        const f = new SectionsFixture(Home.Api())
        const page = await Home.Open(f)
        page.ViewConnectionCommand.Execute()
        await Tick.Settle()
        assert.equal(Home.ActiveService(f), f.Connection)
        assert.ok(f.Content !== page)
        assert.ok(f.Host.Provider.getRequired(ConnectionSectionService.Key).Current !== undefined)
        assert.equal(f.Host.Provider.getRequired(EnvironmentsSectionService.Key).Current, undefined)
    })
})
