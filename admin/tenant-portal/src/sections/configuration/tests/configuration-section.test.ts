import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { ApiError } from '../../../tenant-api-client.js'
import { ConfigurationApplyOutcome, ConfigurationChangeKind } from '../../../tenant-types.js'
import { PageState } from '../../../shell/tenant-page-view-model.js'
import { FakeTenantApi, TenantTestHost, TestRail, Tick } from '../../../shell/tests/tenant-test-fixtures.js'
import { ContentHostService } from '@pragmatic-tech-ai/mural/framework/shell/services/content-host-service.js'
import { ConfigurationSectionService } from '../configuration-section-service.js'
import { ConfigurationPageViewModel, type IConfigurationNavigator } from '../configuration-page-view-model.js'
import { ComponentConfigurationPageViewModel } from '../component-configuration-page-view-model.js'
import { ConfigurationEditorViewModel } from '../configuration-editor-view-model.js'

class RecordingNavigator implements IConfigurationNavigator
{
    public readonly Opened: string[] = []
    public Backs = 0
    public readonly BackCommand = new RelayCommand(() => { this.Backs++ })

    public OpenComponent(component: string): void
    {
        this.Opened.push(component)
    }
}

class ConfigFixture
{
    public static readonly Options = [{
        name: 'database', description: 'Where the graph keeps its data.',
        settings: [
            { name: 'url', type: 'string', description: 'The connection URL.', required: true, secret: false },
            { name: 'password', type: 'string', description: 'The database password.', required: true, secret: true },
            { name: 'poolSize', type: 'integer', description: 'Connections kept open.', required: false, secret: false, default: 10 },
        ],
    }]

    public readonly Api: FakeTenantApi
    public readonly Host: TenantTestHost
    public readonly Navigator = new RecordingNavigator()

    public constructor(canEdit: boolean = true)
    {
        this.Api = new FakeTenantApi()
            .WithConfiguration('graph', [{ database: { url: 'postgres://a' } }, { database: { url: 'postgres://b', password: 'secret:vault/graph-db' } }],
                ['production', 'staging'], ConfigFixture.Options)
            .WithConfiguration('relay', [], ['production'])
        this.Host = new TenantTestHost(this.Api, { ...TenantTestHost.AllCapabilities, settings: canEdit })
    }

    public async List(): Promise<ConfigurationPageViewModel>
    {
        const page = new ConfigurationPageViewModel(this.Host.Session, this.Navigator)
        await page.Refresh()
        return page
    }

    public async Component(component: string = 'graph'): Promise<ComponentConfigurationPageViewModel>
    {
        const page = new ComponentConfigurationPageViewModel(this.Host.Session, this.Navigator, component)
        await page.Refresh()
        return page
    }
}

describe('ConfigurationPageViewModel', () =>
{
    it('lists each component with its head and what is applied on each target', async () =>
    {
        const fx = new ConfigFixture()
        fx.Api.ConfigurationTargets.get('graph')![0]!.applied = 2
        const page = await fx.List()
        assert.equal(page.State, PageState.Populated)
        const rows = page.Rows.ToArray()
        assert.deepEqual(rows.map(r => [r.Component, r.HeadText, r.TargetsText]), [
            ['graph', 'Version 2', 'production: version 2 applied; staging: nothing applied'],
            ['relay', 'No versions yet', 'production: nothing applied'],
        ])
        rows[1]!.OpenCommand.Execute()
        assert.deepEqual(fx.Navigator.Opened, ['relay'])
    })

    it('is Empty when the console runs no configurable component, Denied on 403', async () =>
    {
        const empty = new ConfigurationPageViewModel(new TenantTestHost(new FakeTenantApi()).Session, new RecordingNavigator())
        await empty.Refresh()
        assert.equal(empty.State, PageState.Empty)
        const api = new FakeTenantApi()
        api.FailOn.set('ListConfigurationComponents', new ApiError(403, 'forbidden'))
        const denied = new ConfigurationPageViewModel(new TenantTestHost(api).Session, new RecordingNavigator())
        await denied.Refresh()
        assert.equal(denied.State, PageState.Denied)
    })
})

describe('ComponentConfigurationPageViewModel', () =>
{
    it('shows the settings (secret ones as references), the versions newest first, the targets and the applies', async () =>
    {
        const fx = new ConfigFixture()
        const page = await fx.Component()
        assert.equal(page.State, PageState.Populated)
        assert.equal(page.Title, 'graph')
        assert.deepEqual(page.SettingRows.ToArray().map(r => [r.Path, r.TypeText, r.RequiredText, r.DefaultText]), [
            ['database.url', 'string', 'Required', ''],
            ['database.password', 'secret reference', 'Required', ''],
            ['database.poolSize', 'integer', 'Optional', 'Default 10'],
        ])
        assert.deepEqual(page.VersionRows.ToArray().map(r => [r.VersionText, r.IsHead]), [['Version 2', true], ['Version 1', false]])
        assert.deepEqual(page.TargetRows.ToArray().map(r => [r.Environment, r.AppliedText]), [['production', 'Nothing applied'], ['staging', 'Nothing applied']])
        assert.equal(page.HasApplies, false)
    })

    it("views one version's document as indented JSON", async () =>
    {
        const fx = new ConfigFixture()
        const page = await fx.Component()
        page.VersionRows.ToArray()[1]!.ViewCommand.Execute()
        await Tick.Settle()
        assert.equal(page.ViewedTitle, 'Version 1')
        assert.equal(page.ViewedDocumentText, JSON.stringify({ database: { url: 'postgres://a' } }, null, 2))
        assert.equal(page.HasViewed, true)
    })

    it('diffs two versions, from the empty document (0) by default', async () =>
    {
        const fx = new ConfigFixture()
        fx.Api.ConfigurationDiff = { from: 0, to: 0, changes: [
            { path: 'database.url', kind: ConfigurationChangeKind.Changed, before: 'postgres://a', after: 'postgres://b' },
            { path: 'database.password', kind: ConfigurationChangeKind.Added, after: 'secret:vault/graph-db' },
        ] }
        const page = await fx.Component()
        assert.deepEqual(page.FromOptions.ToArray().map(o => o.Label), ['Empty document', 'Version 2', 'Version 1'])
        assert.equal(page.SelectedFrom?.Value, 0)
        assert.equal(page.SelectedTo?.Value, 2)
        page.CompareCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.Calls.find(c => c[0] === 'DiffConfigurationVersions'), ['DiffConfigurationVersions', 'graph', 0, 2])
        assert.deepEqual(page.ChangeRows.ToArray().map(r => [r.Path, r.KindText, r.BeforeText, r.AfterText]), [
            ['database.url', 'Changed', '"postgres://a"', '"postgres://b"'],
            ['database.password', 'Added', '', '"secret:vault/graph-db"'],
        ])
        assert.equal(page.DiffSummaryText, '2 changes from the empty document to version 2.')
        page.SelectedFrom = page.FromOptions.ToArray()[1]
        assert.equal(page.CompareCommand.CanExecute(), false)
    })

    it('starts the editor from the head and saves a new version based on it', async () =>
    {
        const fx = new ConfigFixture()
        const page = await fx.Component()
        const editor = page.Editor
        assert.equal(editor.BasedOn, 2)
        assert.equal(editor.Text, JSON.stringify({ database: { url: 'postgres://b', password: 'secret:vault/graph-db' } }, null, 2))
        assert.equal(page.SaveCommand.CanExecute(), false, 'nothing changed yet')
        editor.Text = '{ "database": { "url": "postgres://c", "password": "secret:vault/graph-db" } }'
        editor.Comment = 'move the database'
        assert.equal(page.SaveCommand.CanExecute(), true)
        page.SaveCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.Calls.find(c => c[0] === 'SaveConfigurationVersion'),
            ['SaveConfigurationVersion', 'graph', 2, { database: { url: 'postgres://c', password: 'secret:vault/graph-db' } }, 'move the database'])
        assert.equal(page.NoticeText, 'Saved version 3.')
        assert.equal(page.Editor.BasedOn, 3)
        assert.equal(page.VersionRows.ToArray()[0]?.VersionText, 'Version 3')
    })

    it('a document that is not a JSON object cannot be saved, and says why', async () =>
    {
        const fx = new ConfigFixture()
        const page = await fx.Component()
        page.Editor.Text = '{ "database": '
        assert.equal(page.SaveCommand.CanExecute(), false)
        assert.equal(page.Editor.ParseErrorText, 'This is not valid JSON yet.')
        page.Editor.Text = '[1, 2]'
        assert.equal(page.Editor.ParseErrorText, 'The document must be a JSON object.')
        page.Editor.Text = '{}'
        assert.equal(page.Editor.ParseErrorText, '')
    })

    it("shows the server's validation errors per path (422) and keeps the edit", async () =>
    {
        const fx = new ConfigFixture()
        const page = await fx.Component()
        fx.Api.FailOn.set('SaveConfigurationVersion', new ApiError(422, 'The document does not validate.', undefined, {
            error: 'The document does not validate.',
            errors: [{ path: 'database.password', message: 'A secret setting takes a secret reference (secret:<store>/<name>), not a value.' }, { path: 'database.url', message: 'Required.' }],
        }))
        page.Editor.Text = '{ "database": { "password": "hunter2" } }'
        page.SaveCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(page.Editor.ErrorRows.ToArray().map(r => [r.Path, r.Message]), [
            ['database.password', 'A secret setting takes a secret reference (secret:<store>/<name>), not a value.'],
            ['database.url', 'Required.'],
        ])
        assert.equal(page.Editor.HasErrors, true)
        assert.equal(page.Editor.Text, '{ "database": { "password": "hunter2" } }')
        assert.equal(page.CommandErrorText, '')
        page.Editor.Text = '{ "database": { "password": "secret:vault/db" } }'
        assert.equal(page.Editor.HasErrors, false, 'an edit clears the stale errors')
    })

    it('says when the head moved meanwhile (409) and reloads the editor on request', async () =>
    {
        const fx = new ConfigFixture()
        const page = await fx.Component()
        fx.Api.ConfigurationDocuments.get('graph')!.push({ database: { url: 'postgres://elsewhere' } })
        page.Editor.Text = '{ "database": { "url": "postgres://mine" } }'
        page.SaveCommand.Execute()
        await Tick.Settle()
        assert.equal(page.Editor.ConflictText, 'Someone saved version 3 while you were editing. Start again from it to keep both changes.')
        page.ReloadEditorCommand.Execute()
        await Tick.Settle()
        assert.equal(page.Editor.BasedOn, 3)
        assert.equal(page.Editor.ConflictText, '')
        assert.equal(page.Editor.Text, JSON.stringify({ database: { url: 'postgres://elsewhere' } }, null, 2))
    })

    it('the first version of a component starts from an empty object', async () =>
    {
        const fx = new ConfigFixture()
        const page = await fx.Component('relay')
        assert.equal(page.Editor.BasedOn, 0)
        assert.equal(page.Editor.Text, '{}')
        assert.equal(page.Editor.BasedOnText, 'The first version.')
    })

    it('applies a version to one of its targets and shows the outcome', async () =>
    {
        const fx = new ConfigFixture()
        const page = await fx.Component()
        assert.deepEqual(page.TargetOptions.ToArray().map(o => o.Label), ['production', 'staging'])
        page.SelectedTarget = page.TargetOptions.ToArray()[1]
        assert.equal(page.SelectedApplyVersion?.Value, 2)
        page.ApplyCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.Calls.find(c => c[0] === 'ApplyConfigurationVersion'), ['ApplyConfigurationVersion', 'graph', 2, 'staging'])
        assert.equal(page.NoticeText, 'Applied version 2 to staging.')
        assert.deepEqual(page.TargetRows.ToArray().map(r => [r.Environment, r.AppliedText]), [['production', 'Nothing applied'], ['staging', 'Version 2 applied']])
        assert.deepEqual(page.ApplyRows.ToArray().map(r => [r.VersionText, r.Environment, r.OutcomeText]), [['Version 2', 'staging', 'Applied']])
    })

    it('a failed apply says so with its detail', async () =>
    {
        const fx = new ConfigFixture()
        fx.Api.ApplyOutcome = ConfigurationApplyOutcome.Failed
        fx.Api.ApplyDetail = 'The deployment did not roll out.'
        const page = await fx.Component()
        page.SelectedTarget = page.TargetOptions.ToArray()[0]
        page.ApplyCommand.Execute()
        await Tick.Settle()
        assert.equal(page.NoticeText, 'Applying version 2 to production failed: The deployment did not roll out.')
    })

    it('offers save and apply only with the settings permission (the tenant admin role); reads stay open', async () =>
    {
        const fx = new ConfigFixture(false)
        const page = await fx.Component()
        assert.equal(page.State, PageState.Populated)
        assert.equal(page.CanMutate, false)
        assert.equal(page.DeniedReason, 'Needs the Manage tenant settings permission. Ask owner@example.test.')
        page.Editor.Text = '{ "database": {} }'
        page.SelectedTarget = page.TargetOptions.ToArray()[0]
        assert.equal(page.SaveCommand.CanExecute(), false)
        assert.equal(page.ApplyCommand.CanExecute(), false)
        assert.equal(page.CompareCommand.CanExecute(), true)
    })
})

describe('ConfigurationEditorViewModel', () =>
{
    it('is dirty once the text differs from the version it is based on', () =>
    {
        const editor = new ConfigurationEditorViewModel()
        editor.Reset(1, { a: 1 })
        assert.equal(editor.IsDirty, false)
        editor.Text = '{ "a": 2 }'
        assert.equal(editor.IsDirty, true)
        assert.deepEqual(editor.Document, { a: 2 })
        editor.Reset(2, { a: 2 })
        assert.equal(editor.IsDirty, false)
        assert.equal(editor.BasedOnText, 'Based on version 2.')
    })
})

describe('ConfigurationSectionService', () =>
{
    it('opens a component from the list and goes back to the list', async () =>
    {
        const fx = new ConfigFixture()
        fx.Host.Provider.register(ConfigurationSectionService.Key, (p) => new ConfigurationSectionService(p))
        const rail = new TestRail(fx.Host.Provider)
        rail.Add(ConfigurationSectionService.Key)
        rail.Select(ConfigurationSectionService.Key)
        await Tick.Settle()
        const content = (): unknown => fx.Host.Provider.getRequired(ContentHostService.Key).Content
        const list = content()
        assert.ok(list instanceof ConfigurationPageViewModel)
        list.Rows.ToArray()[0]!.OpenCommand.Execute()
        await Tick.Settle()
        const detail = content()
        assert.ok(detail instanceof ComponentConfigurationPageViewModel)
        assert.equal(detail.Title, 'graph')
        assert.equal(detail.State, PageState.Populated)
        detail.BackCommand.Execute()
        await Tick.Settle()
        assert.ok(content() instanceof ConfigurationPageViewModel)
    })
})
