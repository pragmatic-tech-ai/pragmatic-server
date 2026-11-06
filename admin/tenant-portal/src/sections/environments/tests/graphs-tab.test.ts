import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TenantApiError } from '../../../tenant-api-client.js'
import { EnvType, type GraphDto } from '../../../tenant-types.js'
import { ConfirmDialogViewModel } from '../../../shell/confirm-dialog-view-model.js'
import { FakeTenantApi, TenantTestHost, Tick } from '../../../shell/tests/tenant-test-fixtures.js'
import { UtcText } from '../../../shell/utc-text.js'
import { CreateGraphDialogViewModel } from '../create-graph-dialog-view-model.js'
import { EnvironmentDetailPageViewModel, EnvironmentDetailTab } from '../environment-detail-page-view-model.js'
import { SectionsFixture } from './sections-fixture.js'

const NoEnvironments = { envs: false, adopt: true, access: true, settings: true }
const UnreachableSentence = 'This console cannot reach its environments, so graphs are unavailable here.'
const ExistsSentence = 'A graph with that name already exists in this environment.'
const NotFoundSentence = 'That graph does not exist in this environment.'

class GraphsFixture
{
    // A tenant surface with a Development environment `name` holding `graphs`.
    public static Development(name: string, graphs: GraphDto[] = []): FakeTenantApi
    {
        const api = new FakeTenantApi().WithEnvironment(name)
        api.Environments[api.Environments.length - 1]!.type = EnvType.Development
        api.Graphs.set(name, graphs)
        return api
    }

    public static Graph(name: string, packageCount: number, description: string = 'About ' + name): GraphDto
    {
        return { name, description, createdAt: '2026-11-01T10:20:30.000Z', packageCount }
    }

    // Opens `name`'s detail (Environments in front) and waits for it and its Graphs tab.
    public static async Detail(f: SectionsFixture, name: string): Promise<EnvironmentDetailPageViewModel>
    {
        f.Environments.OpenEnvironment(name)
        await Tick.Settle()
        const page = f.Content
        assert.ok(page instanceof EnvironmentDetailPageViewModel)
        return page
    }
}

describe('Graphs tab', () =>
{
    it('shows a Graphs tab only for a Development environment', async () =>
    {
        const dev = await GraphsFixture.Detail(new SectionsFixture(GraphsFixture.Development('dev1')), 'dev1')
        assert.deepEqual(dev.TabLabels.ToArray(), ['Application & version', 'Health & activity', 'Access', 'Graphs'])
        assert.equal(dev.GraphsTab.Environment, 'dev1')
        assert.equal(dev.IsGraphsTab, false)
        dev.SelectedTab = 'Graphs'
        assert.equal(dev.Tab, EnvironmentDetailTab.Graphs)
        assert.equal(dev.IsGraphsTab, true)
        assert.equal(dev.IsApplicationTab, false)

        // No longer Development on a reload: the tab goes, back to Application.
        const flipped = new SectionsFixture(GraphsFixture.Development('dev2'))
        const page = await GraphsFixture.Detail(flipped, 'dev2')
        page.SelectedTab = 'Graphs'
        flipped.Api.Environments[0]!.type = EnvType.Runtime
        await page.Refresh()
        assert.deepEqual(page.TabLabels.ToArray(), ['Application & version', 'Health & activity', 'Access'])
        assert.equal(page.IsGraphsTab, false)
        assert.equal(page.Tab, EnvironmentDetailTab.Application)

        const api = new FakeTenantApi().WithEnvironment('run1')
        const runtime = await GraphsFixture.Detail(new SectionsFixture(api), 'run1')
        assert.deepEqual(runtime.TabLabels.ToArray(), ['Application & version', 'Health & activity', 'Access'])
        assert.equal(runtime.GraphsTab.Environment, undefined)
        assert.equal(api.Count('ListGraphs'), 0)
    })

    it('lists the graphs with packages and created time, and is Empty without any', async () =>
    {
        const api = GraphsFixture.Development('dev1', [GraphsFixture.Graph('sales', 1), GraphsFixture.Graph('ops', 3, '')])
        const page = await GraphsFixture.Detail(new SectionsFixture(api), 'dev1')
        const tab = page.GraphsTab
        assert.equal(tab.IsPopulated, true)
        const rows = tab.Rows.ToArray()
        assert.deepEqual(rows.map(r => r.Name), ['sales', 'ops'])
        assert.deepEqual(rows.map(r => r.Description), ['About sales', ''])
        assert.deepEqual(rows.map(r => r.PackagesText), ['1 package', '3 packages'])
        assert.equal(rows[0]!.CreatedText, UtcText.DateTime('2026-11-01T10:20:30.000Z'))
        assert.deepEqual(api.Calls.find(c => c[0] === 'ListGraphs'), ['ListGraphs', 'dev1'])

        const empty = await GraphsFixture.Detail(new SectionsFixture(GraphsFixture.Development('dev1')), 'dev1')
        assert.equal(empty.GraphsTab.IsEmpty, true)
        assert.equal(empty.GraphsTab.Rows.Count, 0)
    })

    it("shows the route's sentence when graphs cannot be listed", async () =>
    {
        const api = GraphsFixture.Development('dev1', [GraphsFixture.Graph('sales', 1)])
        api.FailOn.set('ListGraphs', new TenantApiError(503, UnreachableSentence))
        const page = await GraphsFixture.Detail(new SectionsFixture(api), 'dev1')
        assert.equal(page.GraphsTab.IsError, true)
        assert.equal(page.GraphsTab.ErrorText, UnreachableSentence)
        assert.equal(page.IsPopulated, true)
    })

    it("creates a graph: the name rule, a server 409 as the route's sentence, then the list reloads", async () =>
    {
        const host = new TenantTestHost(GraphsFixture.Development('dev1', [GraphsFixture.Graph('taken', 0)]))
        const local = new CreateGraphDialogViewModel(host.Session, host.UseDialogs(), 'dev1', ['sales'])
        assert.equal(local.NameErrorText, '')
        assert.equal(local.ConfirmCommand.CanExecute(), false)
        local.Name = 'Bad'
        assert.equal(local.NameErrorText, CreateGraphDialogViewModel.FormatMessage)
        assert.equal(local.NameErrorText, 'Use lowercase letters, digits and hyphens, starting with a letter or digit.')
        assert.equal(local.ConfirmCommand.CanExecute(), false)
        local.Name = 'sales'
        assert.equal(local.NameErrorText, 'A graph with this name exists in this environment.')
        assert.equal(local.ConfirmCommand.CanExecute(), false)
        local.Name = '1st-graph'
        assert.equal(local.NameErrorText, '')
        assert.equal(local.ConfirmCommand.CanExecute(), true)

        // A name taken meanwhile: the server's 409 shows the route's sentence and the dialog stays open.
        const api = GraphsFixture.Development('dev1', [GraphsFixture.Graph('sales', 2)])
        const f = new SectionsFixture(api)
        const page = await GraphsFixture.Detail(f, 'dev1')
        const tab = page.GraphsTab
        assert.equal(tab.NewGraphCommand.CanExecute(), true)
        tab.NewGraphCommand.Execute()
        await Tick.Settle()
        const dialog = f.Dialogs.Last
        assert.ok(dialog instanceof CreateGraphDialogViewModel)
        assert.equal(f.Dialogs.Shown[f.Dialogs.Shown.length - 1]!.Title, 'New graph')
        api.Graphs.get('dev1')!.push(GraphsFixture.Graph('late', 0))
        dialog.Name = 'late'
        await dialog.Confirm()
        assert.equal(dialog.ErrorText, ExistsSentence)
        assert.equal(f.Dialogs.IsOpen, true)

        api.FailOn.set('CreateGraph', new TypeError('Failed to fetch'))
        dialog.Name = 'fresh'
        await dialog.Confirm()
        assert.equal(dialog.ErrorText, 'Could not create the graph. Please try again.')
        api.FailOn.delete('CreateGraph')

        dialog.Description = 'Fresh numbers'
        await dialog.Confirm()
        await Tick.Settle()
        assert.equal(f.Dialogs.IsOpen, false)
        assert.deepEqual(api.Calls.filter(c => c[0] === 'CreateGraph').at(-1), ['CreateGraph', 'dev1', { name: 'fresh', description: 'Fresh numbers' }])
        assert.deepEqual(tab.Rows.ToArray().map(r => r.Name), ['sales', 'late', 'fresh'])
        assert.equal(tab.Rows.ToArray()[2]!.PackagesText, '0 packages')
    })

    it('deletes a graph only after the confirm, then reloads', async () =>
    {
        const api = GraphsFixture.Development('dev1', [GraphsFixture.Graph('sales', 1), GraphsFixture.Graph('ops', 0)])
        const f = new SectionsFixture(api)
        const page = await GraphsFixture.Detail(f, 'dev1')
        const tab = page.GraphsTab
        const sales = tab.Rows.ToArray()[0]!
        assert.equal(sales.DeleteCommand.CanExecute(), true)

        sales.DeleteCommand.Execute()
        await Tick.Settle()
        const cancelled = f.Dialogs.Last
        assert.ok(cancelled instanceof ConfirmDialogViewModel)
        cancelled.Cancel()
        await Tick.Settle()
        assert.equal(api.Count('DeleteGraph'), 0)

        sales.DeleteCommand.Execute()
        await Tick.Settle()
        const confirm = f.Dialogs.Last
        assert.ok(confirm instanceof ConfirmDialogViewModel)
        assert.equal(f.Dialogs.Shown[f.Dialogs.Shown.length - 1]!.Title, 'Delete graph sales?')
        assert.equal(confirm.Message, 'Deleting sales removes it from dev1, with every package contributed to it.')
        assert.equal(confirm.ConfirmLabel, 'Delete graph')
        assert.equal(confirm.ConsequencesText, '- Plexus can no longer contribute to it.\n- This cannot be undone.')
        await confirm.Confirm()
        await Tick.Settle()
        assert.deepEqual(api.Calls.find(c => c[0] === 'DeleteGraph'), ['DeleteGraph', 'dev1', 'sales'])
        assert.deepEqual(tab.Rows.ToArray().map(r => r.Name), ['ops'])
    })

    it("keeps the confirm open with the route's sentence when a delete is refused", async () =>
    {
        const api = GraphsFixture.Development('dev1', [GraphsFixture.Graph('sales', 1)])
        const f = new SectionsFixture(api)
        const page = await GraphsFixture.Detail(f, 'dev1')
        const tab = page.GraphsTab
        api.FailOn.set('DeleteGraph', new TenantApiError(404, NotFoundSentence))
        tab.Rows.ToArray()[0]!.DeleteCommand.Execute()
        await Tick.Settle()
        const confirm = f.Dialogs.Last
        assert.ok(confirm instanceof ConfirmDialogViewModel)
        await confirm.Confirm()
        await Tick.Settle()
        assert.equal(confirm.ErrorText, NotFoundSentence)
        assert.equal(f.Dialogs.IsOpen, true)
        assert.deepEqual(tab.Rows.ToArray().map(r => r.Name), ['sales'])
    })

    it('creates nothing when New graph is cancelled', async () =>
    {
        const api = GraphsFixture.Development('dev1', [GraphsFixture.Graph('sales', 1)])
        const f = new SectionsFixture(api)
        const page = await GraphsFixture.Detail(f, 'dev1')
        page.GraphsTab.NewGraphCommand.Execute()
        await Tick.Settle()
        const dialog = f.Dialogs.Last
        assert.ok(dialog instanceof CreateGraphDialogViewModel)
        dialog.Name = 'fresh'
        dialog.Cancel()
        await Tick.Settle()
        assert.equal(f.Dialogs.IsOpen, false)
        assert.equal(api.Count('CreateGraph'), 0)
        assert.deepEqual(page.GraphsTab.Rows.ToArray().map(r => r.Name), ['sales'])
    })

    it('reloads the graphs with the detail, and shows fresh rows after Runtime and back to Development', async () =>
    {
        const api = GraphsFixture.Development('dev1', [GraphsFixture.Graph('sales', 1)])
        const page = await GraphsFixture.Detail(new SectionsFixture(api), 'dev1')
        const tab = page.GraphsTab
        assert.deepEqual(tab.Rows.ToArray().map(r => r.PackagesText), ['1 package'])
        api.Graphs.get('dev1')![0]!.packageCount = 4
        await page.Refresh()
        await Tick.Settle()
        assert.deepEqual(tab.Rows.ToArray().map(r => r.PackagesText), ['4 packages'])

        api.Environments[0]!.type = EnvType.Runtime
        await page.Refresh()
        await Tick.Settle()
        assert.equal(tab.Environment, undefined)
        assert.equal(tab.Rows.Count, 0)

        api.Graphs.set('dev1', [GraphsFixture.Graph('ops', 2)])
        api.Environments[0]!.type = EnvType.Development
        await page.Refresh()
        await Tick.Settle()
        assert.equal(tab.Environment, 'dev1')
        assert.deepEqual(tab.Rows.ToArray().map(r => r.Name), ['ops'])
        assert.deepEqual(tab.Rows.ToArray().map(r => r.PackagesText), ['2 packages'])
    })

    it('disables New graph and Delete without the Environments permission', async () =>
    {
        const api = GraphsFixture.Development('dev1', [GraphsFixture.Graph('sales', 1)])
        const f = new SectionsFixture(api, NoEnvironments)
        const page = await GraphsFixture.Detail(f, 'dev1')
        const tab = page.GraphsTab
        assert.equal(tab.IsPopulated, true)
        const remove = tab.Rows.ToArray()[0]!.DeleteCommand
        for (const command of [tab.NewGraphCommand, remove])
        {
            assert.equal(command.CanExecute(), false)
            command.Execute()
        }
        await Tick.Settle()
        assert.equal(f.Dialogs.Shown.length, 0)
        assert.equal(api.Count('CreateGraph') + api.Count('DeleteGraph'), 0)
        assert.equal(tab.DeniedReason, 'Needs the Manage environments permission. Ask owner@example.test.')
    })
})
