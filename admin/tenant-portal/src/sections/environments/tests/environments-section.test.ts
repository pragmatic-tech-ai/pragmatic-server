import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TenantApiError } from '../../../tenant-api-client.js'
import { EnvStatus, EnvType, Template, TenantEventType } from '../../../tenant-types.js'
import { ConfirmDialogViewModel } from '../../../shell/confirm-dialog-view-model.js'
import { NameConfirmDialogViewModel } from '../../../shell/name-confirm-dialog-view-model.js'
import { PageState } from '../../../shell/tenant-page-view-model.js'
import { FakeTenantApi, TenantTestHost, Tick } from '../../../shell/tests/tenant-test-fixtures.js'
import { OverviewSectionService } from '../../overview/overview-section-service.js'
import { CreateEnvironmentDialogViewModel } from '../create-environment-dialog-view-model.js'
import { EnvironmentDetailPageViewModel, EnvironmentDetailTab } from '../environment-detail-page-view-model.js'
import { EnvironmentsPageViewModel } from '../environments-page-view-model.js'
import { EnvironmentsSectionService } from '../environments-section-service.js'
import { SectionsFixture } from './sections-fixture.js'

const NoEnvironments = { envs: false, adopt: true, access: true, settings: true }

class Opened
{
    // Selects Environments and waits for its list to load.
    public static async List(f: SectionsFixture): Promise<EnvironmentsPageViewModel>
    {
        f.Rail.Select(EnvironmentsSectionService)
        await Tick.Settle()
        const page = f.Content
        assert.ok(page instanceof EnvironmentsPageViewModel)
        return page
    }

    // Opens `name`'s detail (Environments in front) and waits for it.
    public static async Detail(f: SectionsFixture, name: string): Promise<EnvironmentDetailPageViewModel>
    {
        f.Environments.OpenEnvironment(name)
        await Tick.Settle()
        const page = f.Content
        assert.ok(page instanceof EnvironmentDetailPageViewModel)
        return page
    }
}

describe('Create environment dialog', () =>
{
    it('validates the name format and duplicates, and keeps Create disabled until valid', () =>
    {
        const host = new TenantTestHost(new FakeTenantApi())
        const dialog = new CreateEnvironmentDialogViewModel(host.Session, host.UseDialogs(), ['alpha'])
        assert.equal(dialog.NameErrorText, '')
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
        dialog.Name = 'A'
        assert.equal(dialog.NameErrorText, 'Use 3-31 lowercase letters, digits or hyphens, starting with a letter.')
        dialog.Name = 'alpha'
        assert.equal(dialog.NameErrorText, 'An environment with this name exists.')
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
        dialog.Name = 'beta-1'
        assert.equal(dialog.NameErrorText, '')
        assert.equal(dialog.ConfirmCommand.CanExecute(), true)
        assert.equal(dialog.SelectedTemplate.Value, Template.DevBlank)
        assert.equal(dialog.SelectedType.Value, EnvType.Runtime)
        assert.deepEqual(dialog.Templates.ToArray().map(t => t.Label),
            ['Blank development (dev-blank)', 'Contoso demo (demo-contoso)', 'Runtime with Postgres (runtime-postgres)'])
    })

    it('shows a 409 as the duplicate message and stays open; submits the chosen template and type', async () =>
    {
        const api = new FakeTenantApi().WithEnvironment('taken')
        const host = new TenantTestHost(api)
        const dialogs = host.UseDialogs()
        const dialog = new CreateEnvironmentDialogViewModel(host.Session, dialogs, [])
        const opened = dialog.Open('Create environment')
        dialog.Name = 'taken'
        await dialog.Confirm()
        assert.equal(dialog.ErrorText, 'An environment with this name exists.')
        assert.equal(dialogs.IsOpen, true)
        dialog.Name = 'fresh'
        dialog.SelectedTemplate = dialog.Templates.ToArray()[1]!
        dialog.SelectedType = dialog.Types.ToArray()[0]!
        await dialog.Confirm()
        const created = await opened
        assert.equal(created?.name, 'fresh')
        assert.deepEqual(api.Calls.filter(c => c[0] === 'CreateEnvironment')[1], ['CreateEnvironment', { name: 'fresh', template: Template.DemoContoso, type: EnvType.Development }])
    })

    it('opens the created environment from the list, and is disabled without the permission', async () =>
    {
        const f = new SectionsFixture(new FakeTenantApi().WithEnvironment('alpha'))
        const list = await Opened.List(f)
        list.CreateCommand.Execute()
        await Tick.Settle()
        const dialog = f.Dialogs.Last
        assert.ok(dialog instanceof CreateEnvironmentDialogViewModel)
        dialog.Name = 'beta'
        await dialog.Confirm()
        await Tick.Settle()
        const detail = f.Content
        assert.ok(detail instanceof EnvironmentDetailPageViewModel)
        assert.equal(detail.Name, 'beta')
        assert.equal(detail.State, PageState.Populated)

        const denied = new SectionsFixture(new FakeTenantApi().WithEnvironment('alpha'), NoEnvironments)
        const deniedList = await Opened.List(denied)
        assert.equal(deniedList.CreateCommand.CanExecute(), false)
        assert.equal(deniedList.DeniedReason, 'Needs the Manage environments permission. Ask owner@example.test.')
        deniedList.CreateCommand.Execute()
        await Tick.Settle()
        assert.equal(denied.Dialogs.Shown.length, 0)
    })
})

describe('Environments list', () =>
{
    it('lists environments with health, filters by name, id or version, and is Empty without any', async () =>
    {
        const api = new FakeTenantApi()
            .WithEnvironment('alpha', EnvStatus.Running, 'hive-1', 'registry/app:1.2')
            .WithEnvironment('beta', EnvStatus.Stopped)
        const f = new SectionsFixture(api)
        const list = await Opened.List(f)
        assert.equal(list.State, PageState.Populated)
        const [alpha, beta] = list.Rows.ToArray()
        assert.equal(alpha?.HealthPill.Label, 'Healthy')
        assert.equal(alpha?.Version, '1.2')
        assert.equal(alpha?.UrlText, 'https://alpha.example.test')
        assert.equal(alpha?.SubText, 'env-alpha \u00b7 dev-blank')
        assert.equal(beta?.StatusPill.Label, 'Stopped')
        assert.equal(beta?.UrlText, 'Stopped')
        list.Filter = 'BET'
        assert.deepEqual(list.Rows.ToArray().map(r => r.Name), ['beta'])
        list.Filter = 'env-alpha'
        assert.deepEqual(list.Rows.ToArray().map(r => r.Name), ['alpha'])
        list.Filter = '1.2'
        assert.deepEqual(list.Rows.ToArray().map(r => r.Name), ['alpha'])
        list.Filter = 'zzz'
        assert.equal(list.HasNoMatches, true)

        const empty = await Opened.List(new SectionsFixture(new FakeTenantApi()))
        assert.equal(empty.State, PageState.Empty)
    })

    it('degrades a failed health read, and is Error when the list fails', async () =>
    {
        const api = new FakeTenantApi().WithEnvironment('alpha')
        api.FailOn.set('GetHealth', new TenantApiError(500, 'health down'))
        const list = await Opened.List(new SectionsFixture(api))
        assert.equal(list.State, PageState.Populated)
        assert.equal(list.Rows.ToArray()[0]?.HealthPill.Label, 'Unknown')

        const failing = new FakeTenantApi()
        failing.FailOn.set('ListEnvironments', new TenantApiError(500, 'boom'))
        const failed = await Opened.List(new SectionsFixture(failing))
        assert.equal(failed.State, PageState.Error)
        assert.equal(failed.ErrorText, 'boom')
    })

    it('selects all shown rows and runs bulk actions only where they apply, one at a time', async () =>
    {
        const api = new FakeTenantApi()
            .WithEnvironment('alpha', EnvStatus.Running)
            .WithEnvironment('beta', EnvStatus.Stopped)
            .WithEnvironment('gamma', EnvStatus.Running)
        const f = new SectionsFixture(api)
        const list = await Opened.List(f)
        assert.equal(list.StartCommand.CanExecute(), false)
        list.Filter = 'a'
        list.AllSelected = true
        assert.deepEqual(list.SelectedNames, ['alpha', 'beta', 'gamma'])
        assert.equal(list.SelectionText, '3 selected')
        assert.equal(list.StartCommand.CanExecute(), true)
        list.StopCommand.Execute()
        await Tick.Settle()
        // Stop asks first, naming the running environments it will stop.
        const ask = f.Dialogs.Last
        assert.ok(ask instanceof ConfirmDialogViewModel)
        assert.equal(ask.Message, 'Stops: alpha, gamma')
        assert.equal(api.Count('StopEnvironment'), 0)
        await ask.Confirm()
        await Tick.Settle()
        assert.deepEqual(api.Calls.filter(c => c[0] === 'StopEnvironment'), [['StopEnvironment', 'alpha'], ['StopEnvironment', 'gamma']])
        assert.equal(list.HasSelection, false)
        assert.ok(list.Rows.ToArray().every(r => r.StatusPill.Label === 'Stopped'))

        list.Rows.ToArray()[0]!.IsSelected = true
        assert.equal(list.RestartCommand.CanExecute(), false)
        list.StartCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(api.Calls.filter(c => c[0] === 'StartEnvironment'), [['StartEnvironment', 'alpha']])
    })

    it('unselects environments the filter hides, so bulk actions act only on what is shown', async () =>
    {
        const api = new FakeTenantApi().WithEnvironment('alpha', EnvStatus.Stopped).WithEnvironment('beta', EnvStatus.Stopped)
        const list = await Opened.List(new SectionsFixture(api))
        list.AllSelected = true
        list.Filter = 'beta'
        assert.deepEqual(list.SelectedNames, ['beta'])
        list.StartCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(api.Calls.filter(c => c[0] === 'StartEnvironment'), [['StartEnvironment', 'beta']])
    })

    it('reads health for environments without their own hive from the tenant hive', async () =>
    {
        const api = new FakeTenantApi().WithEnvironment('alpha', EnvStatus.Running, '', 'registry/app:2')
        const list = await Opened.List(new SectionsFixture(api))
        assert.deepEqual(api.Calls.filter(c => c[0] === 'GetHealth'), [['GetHealth', 'hive-1']])
        assert.equal(list.Rows.ToArray()[0]!.HealthPill.Label, 'Healthy')
    })

    it('reports the first refusal, still runs the rest, then clears the selection and reloads', async () =>
    {
        const api = new FakeTenantApi().WithEnvironment('alpha', EnvStatus.Running).WithEnvironment('beta', EnvStatus.Running)
        const list = await Opened.List(new SectionsFixture(api))
        list.AllSelected = true
        api.FailOn.set('RestartEnvironment', new TenantApiError(409, 'busy'))
        const loadsBefore = api.Count('ListEnvironments')
        list.RestartCommand.Execute()
        await Tick.Settle()
        assert.equal(api.Count('RestartEnvironment'), 2)
        assert.equal(list.CommandErrorText, 'busy')
        assert.equal(list.HasSelection, false)
        assert.equal(api.Count('ListEnvironments'), loadsBefore + 1)
    })

    it('disables bulk actions without the permission and runs nothing when executed', async () =>
    {
        const api = new FakeTenantApi().WithEnvironment('alpha', EnvStatus.Stopped)
        const list = await Opened.List(new SectionsFixture(api, NoEnvironments))
        list.AllSelected = true
        assert.equal(list.StartCommand.CanExecute(), false)
        list.StartCommand.Execute()
        await Tick.Settle()
        assert.equal(api.Count('StartEnvironment'), 0)
    })
})

describe('Environment detail', () =>
{
    it('shows the environment, its health, the newer version offered, and its addresses', async () =>
    {
        const api = new FakeTenantApi()
            .WithEnvironment('alpha', EnvStatus.Running, 'hive-1', 'registry/app:1')
            .WithManifest('1', 'registry/app:1')
            .WithManifest('2', 'registry/app:2', { notes: 'Faster maps' })
        api.Environments[0]!.idpBaseDomain = 'id.example.test'
        const f = new SectionsFixture(api)
        const page = await Opened.Detail(f, 'alpha')
        assert.equal(page.State, PageState.Populated)
        assert.equal(page.StatusPill?.Label, 'Running')
        assert.equal(page.Version, '1')
        assert.equal(page.HealthText, 'Health: ready - ok')
        assert.equal(page.SignInAddress, 'env-alpha.id.example.test')
        assert.equal(page.UiBundleText, 'No UI bundle deployed yet')
        assert.equal(page.SignatureText, 'Not applicable')
        assert.equal(page.HasOffer, true)
        assert.equal(page.OfferTitle, 'Version 2 is offered.')
        page.ReviewAdoptCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(f.Releases.Adopted, ['2'])
        page.SelectedTab = 'Access'
        assert.equal(page.Tab, EnvironmentDetailTab.Access)
        assert.equal(page.IsAccessTab, true)
        assert.equal(page.IsApplicationTab, false)
    })

    it('says it is on the newest version when nothing newer is offered, and degrades health and versions', async () =>
    {
        const api = new FakeTenantApi().WithEnvironment('alpha', EnvStatus.Running, 'hive-1', 'registry/app:2').WithManifest('2', 'registry/app:2')
        const page = await Opened.Detail(new SectionsFixture(api), 'alpha')
        assert.equal(page.HasOffer, false)
        assert.equal(page.NewestText, 'alpha is on the newest version offered to your hive.')

        const degraded = new FakeTenantApi().WithEnvironment('alpha')
        degraded.FailOn.set('GetHealth', new TenantApiError(500, 'down'))
        degraded.FailOn.set('ListManifests', new TenantApiError(500, 'down'))
        const degradedPage = await Opened.Detail(new SectionsFixture(degraded), 'alpha')
        assert.equal(degradedPage.State, PageState.Populated)
        assert.equal(degradedPage.HealthText, 'Health: unavailable')
        assert.equal(degradedPage.HasOffer, false)
    })

    it('goes back to the list when its environment was deleted, even while another section was active', async () =>
    {
        const api = new FakeTenantApi().WithEnvironment('alpha').WithEnvironment('beta')
        const f = new SectionsFixture(api)
        await Opened.List(f)
        await Opened.Detail(f, 'alpha')
        f.Rail.Select(OverviewSectionService)
        await Tick.Settle()
        api.Environments = api.Environments.filter(e => e.name !== 'alpha')
        f.Rail.Select(EnvironmentsSectionService)
        await Tick.Settle()
        assert.ok(f.Content instanceof EnvironmentsPageViewModel)
        assert.deepEqual(f.Content.Rows.ToArray().map(r => r.Name), ['beta'])
    })

    it('offers Start whenever the environment is not running, and Restart after a failure', async () =>
    {
        const api = new FakeTenantApi().WithEnvironment('failed', EnvStatus.Failed).WithEnvironment('unknown', EnvStatus.Unknown)
        const f = new SectionsFixture(api)
        const failed = await Opened.Detail(f, 'failed')
        assert.equal(failed.CanStart, true)
        assert.equal(failed.StartCommand.CanExecute(), true)
        assert.equal(failed.CanRestart, true)
        assert.equal(failed.RestartCommand.CanExecute(), true)
        assert.equal(failed.StopCommand.CanExecute(), false)
        const unknown = await Opened.Detail(f, 'unknown')
        assert.equal(unknown.StartCommand.CanExecute(), true)
        assert.equal(unknown.RestartCommand.CanExecute(), false)
    })

    it('offers only what the hive offers: never the current target, never an older version', async () =>
    {
        const api = new FakeTenantApi()
            .WithEnvironment('alpha', EnvStatus.Running, 'hive-1', 'registry/app:1')
            .WithManifest('1', 'registry/app:1')
            .WithManifest('2', 'registry/app:2')
            .WithManifest('3', 'registry/app:3')
        api.Rollout.targetVersion = '3'
        const page = await Opened.Detail(new SectionsFixture(api), 'alpha')
        assert.equal(page.HasOffer, false)
        api.Rollout.targetVersion = '2'
        await page.Refresh()
        assert.equal(page.OfferTitle, 'Version 3 is offered.')
    })

    it('notices a server-side close of the log stream, reconnects on reopen, and drops late chunks of an old stream', async () =>
    {
        const api = new FakeTenantApi().WithEnvironment('alpha')
        const page = await Opened.Detail(new SectionsFixture(api), 'alpha')
        page.ToggleLogsCommand.Execute()
        api.LogStreams[0]!.Push('one\n')
        api.LogStreams[0]!.ServerClose()
        assert.equal(page.IsStreaming, false)
        page.ToggleLogsCommand.Execute()
        page.ToggleLogsCommand.Execute()
        assert.equal(api.LogStreams.length, 2)
        api.LogStreams[1]!.Push('two\n')
        page.ToggleLogsCommand.Execute()
        page.ToggleLogsCommand.Execute()
        assert.equal(api.LogStreams.length, 3)
        api.LogStreams[1]!.Late('late\n')
        assert.equal(page.LogBuffer, 'one\ntwo\n')
    })

    it('starts a stopped environment, and restarts or stops (after a confirm) a running one', async () =>
    {
        const api = new FakeTenantApi().WithEnvironment('alpha', EnvStatus.Stopped)
        const f = new SectionsFixture(api)
        const page = await Opened.Detail(f, 'alpha')
        assert.equal(page.StopCommand.CanExecute(), false)
        assert.equal(page.RestartCommand.CanExecute(), false)
        page.StartCommand.Execute()
        await Tick.Settle()
        assert.equal(api.Count('StartEnvironment'), 1)
        assert.equal(page.IsRunning, true)
        assert.equal(page.StartCommand.CanExecute(), false)

        page.RestartCommand.Execute()
        await Tick.Settle()
        assert.equal(api.Count('RestartEnvironment'), 1)

        page.StopCommand.Execute()
        await Tick.Settle()
        const confirm = f.Dialogs.Last
        assert.ok(confirm instanceof ConfirmDialogViewModel)
        assert.equal(confirm.ConfirmLabel, 'Stop environment')
        assert.equal(api.Count('StopEnvironment'), 0)
        await confirm.Confirm()
        await Tick.Settle()
        assert.equal(api.Count('StopEnvironment'), 1)
        assert.equal(page.IsStopped, true)
    })

    it('does not stop when the confirm is cancelled', async () =>
    {
        const api = new FakeTenantApi().WithEnvironment('alpha', EnvStatus.Running)
        const f = new SectionsFixture(api)
        const page = await Opened.Detail(f, 'alpha')
        page.StopCommand.Execute()
        await Tick.Settle()
        ;(f.Dialogs.Last as ConfirmDialogViewModel).Cancel()
        await Tick.Settle()
        assert.equal(api.Count('StopEnvironment'), 0)
    })

    it('deletes only after the name is typed, then returns to the reloaded list', async () =>
    {
        const api = new FakeTenantApi().WithEnvironment('alpha').WithEnvironment('beta')
        const f = new SectionsFixture(api)
        await Opened.List(f)
        const page = await Opened.Detail(f, 'alpha')
        page.DeleteCommand.Execute()
        await Tick.Settle()
        const confirm = f.Dialogs.Last
        assert.ok(confirm instanceof NameConfirmDialogViewModel)
        assert.equal(confirm.ConfirmLabel, 'Delete environment')
        assert.equal(confirm.ConsequencesText, "- The live URL stops serving immediately.\n- The environment's database and files are deleted.\n- This cannot be undone.")
        confirm.Typed = 'alph'
        assert.equal(confirm.ConfirmCommand.CanExecute(), false)
        confirm.Typed = 'alpha'
        await confirm.Confirm()
        await Tick.Settle()
        assert.deepEqual(api.Calls.find(c => c[0] === 'DeleteEnvironment'), ['DeleteEnvironment', 'alpha'])
        const list = f.Content
        assert.ok(list instanceof EnvironmentsPageViewModel)
        assert.deepEqual(list.Rows.ToArray().map(r => r.Name), ['beta'])
    })

    it('disables every lifecycle command without the permission and opens no dialog', async () =>
    {
        const api = new FakeTenantApi().WithEnvironment('alpha', EnvStatus.Running)
        const f = new SectionsFixture(api, NoEnvironments)
        const page = await Opened.Detail(f, 'alpha')
        for (const command of [page.StartCommand, page.StopCommand, page.RestartCommand, page.DeleteCommand])
        {
            assert.equal(command.CanExecute(), false)
            command.Execute()
        }
        await Tick.Settle()
        assert.equal(f.Dialogs.Shown.length, 0)
        assert.equal(api.Count('RestartEnvironment'), 0)
        assert.equal(page.DeniedReason, 'Needs the Manage environments permission. Ask owner@example.test.')
    })

    it('disables Review and adopt without the Adopt permission', async () =>
    {
        const api = new FakeTenantApi().WithEnvironment('alpha', EnvStatus.Running, 'hive-1', 'registry/app:1').WithManifest('2', 'registry/app:2')
        const f = new SectionsFixture(api, { envs: true, adopt: false, access: true, settings: true })
        const page = await Opened.Detail(f, 'alpha')
        assert.equal(page.HasOffer, true)
        assert.equal(page.ReviewAdoptCommand.CanExecute(), false)
        page.ReviewAdoptCommand.Execute()
        assert.deepEqual(f.Releases.Adopted, [])
        assert.equal(page.AdoptDeniedReason, 'Needs the Adopt versions permission. Ask owner@example.test.')
    })

    it("lists this environment's observed activity", async () =>
    {
        const api = new FakeTenantApi().WithEnvironment('alpha')
        const f = new SectionsFixture(api)
        f.Host.Session.RecordEvent({ type: TenantEventType.HealthChanged, environmentName: 'beta' })
        const page = await Opened.Detail(f, 'alpha')
        assert.equal(page.HasActivity, false)
        f.Host.Session.RecordEvent({ type: TenantEventType.EnvironmentChanged, environmentName: 'alpha' })
        assert.deepEqual(page.ActivityRows.ToArray().map(r => r.Summary), ['Environment alpha was updated'])
    })
})

describe('Environment logs', () =>
{
    it('streams only while the logs panel is open, closing on Hide logs', async () =>
    {
        const api = new FakeTenantApi().WithEnvironment('alpha')
        const page = await Opened.Detail(new SectionsFixture(api), 'alpha')
        assert.equal(api.LogStreams.length, 0)
        assert.equal(page.LogText, 'No logs yet (stream is live while the environment runs).')
        page.ToggleLogsCommand.Execute()
        assert.equal(page.LogsToggleLabel, 'Hide logs')
        assert.equal(api.LogStreams.length, 1)
        assert.equal(api.LogStreams[0]?.Name, 'alpha')
        api.LogStreams[0]!.Push('line 1\n')
        assert.equal(page.LogText, 'line 1\n')
        page.TogglePauseCommand.Execute()
        assert.equal(page.PauseLabel, 'Resume')
        api.LogStreams[0]!.Push('dropped\n')
        assert.equal(page.LogText, 'line 1\n')
        page.TogglePauseCommand.Execute()
        page.ToggleLogsCommand.Execute()
        assert.equal(api.LogStreams[0]?.Closed, true)
        assert.equal(page.IsStreaming, false)
    })

    it('closes the stream when the page is left and reopens it when it returns', async () =>
    {
        const api = new FakeTenantApi().WithEnvironment('alpha')
        const f = new SectionsFixture(api)
        await Opened.List(f)
        const page = await Opened.Detail(f, 'alpha')
        page.ToggleLogsCommand.Execute()
        assert.equal(api.LogStreams.length, 1)
        f.Rail.Select(OverviewSectionService)
        await Tick.Settle()
        assert.equal(api.LogStreams[0]?.Closed, true)
        f.Rail.Select(EnvironmentsSectionService)
        await Tick.Settle()
        assert.equal(f.Content, page)
        assert.equal(api.LogStreams.length, 2)
        assert.equal(api.LogStreams[1]?.Closed, false)
        page.BackCommand.Execute()
        assert.equal(api.LogStreams[1]?.Closed, true)
    })

    it('keeps only the last 100,000 characters', async () =>
    {
        const api = new FakeTenantApi().WithEnvironment('alpha')
        const page = await Opened.Detail(new SectionsFixture(api), 'alpha')
        page.ToggleLogsCommand.Execute()
        api.LogStreams[0]!.Push('a'.repeat(EnvironmentDetailPageViewModel.MaxLogChars))
        api.LogStreams[0]!.Push('tail')
        assert.equal(page.LogBuffer.length, EnvironmentDetailPageViewModel.MaxLogChars)
        assert.ok(page.LogBuffer.endsWith('tail'))
    })
})

describe('Environments section', () =>
{
    it('returns to the list when the open environment is deleted, and reloads otherwise', async () =>
    {
        const api = new FakeTenantApi().WithEnvironment('alpha').WithEnvironment('beta')
        const f = new SectionsFixture(api)
        await Opened.List(f)
        const page = await Opened.Detail(f, 'alpha')
        await f.Environments.OnTenantEvent({ type: TenantEventType.EnvironmentDeleted, environmentName: 'beta' })
        assert.equal(f.Content, page)
        api.Environments = api.Environments.filter(e => e.name !== 'alpha')
        await f.Environments.OnTenantEvent({ type: TenantEventType.EnvironmentDeleted, environmentName: 'alpha' })
        const list: unknown = f.Content
        assert.ok(list instanceof EnvironmentsPageViewModel)
        assert.deepEqual(list.Rows.ToArray().map(r => r.Name), ['beta'])
    })

    it('keeps the detail across a rail round-trip', async () =>
    {
        const f = new SectionsFixture(new FakeTenantApi().WithEnvironment('alpha'))
        await Opened.List(f)
        const page = await Opened.Detail(f, 'alpha')
        page.SelectTab(EnvironmentDetailTab.Health)
        f.Rail.Select(OverviewSectionService)
        await Tick.Settle()
        assert.notEqual(f.Content, page)
        f.Rail.Select(EnvironmentsSectionService)
        await Tick.Settle()
        assert.equal(f.Content, page)
        assert.equal(page.IsHealthTab, true)
        page.BackCommand.Execute()
        assert.ok(f.Content instanceof EnvironmentsPageViewModel)
    })

    it('opens a detail from a list row', async () =>
    {
        const f = new SectionsFixture(new FakeTenantApi().WithEnvironment('alpha'))
        const list = await Opened.List(f)
        list.Rows.ToArray()[0]!.OpenCommand.Execute()
        await Tick.Settle()
        const detail = f.Content
        assert.ok(detail instanceof EnvironmentDetailPageViewModel)
        assert.equal(detail.Name, 'alpha')
    })
})
