import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OperatorContext } from '../../../operator-context.js'
import { NameConfirmDialogViewModel } from '../../../shell/name-confirm-dialog-view-model.js'
import { PageState } from '../../../shell/portal-page-view-model.js'
import { FakeControlPlane, Inspect, PortalTestHost, TestRail, Tick, type FakeDialogService } from '../../../shell/tests/portal-test-fixtures.js'
import { HiveDetailPageViewModel } from '../../hives/hive-detail-page-view-model.js'
import { HivesPageViewModel } from '../../hives/hives-page-view-model.js'
import { HivesSectionService } from '../../hives/hives-section-service.js'
import { NewTenantDialogViewModel } from '../new-tenant-dialog-view-model.js'
import { OwnerPasswordRevealPageViewModel } from '../owner-password-reveal-page-view-model.js'
import { TenantDetailPageViewModel } from '../tenant-detail-page-view-model.js'
import { TenantsPageViewModel } from '../tenants-page-view-model.js'
import { TenantsSectionService } from '../tenants-section-service.js'

// Tenants and Hives sections behind a real rail, over a fake control plane.
class TenantsFixture
{
    public readonly Api: FakeControlPlane
    public readonly Host: PortalTestHost
    public readonly Dialogs: FakeDialogService
    public readonly Clipboard: string[]
    public readonly Rail: TestRail

    public constructor(wireRole: string = OperatorContext.FullWireRole)
    {
        this.Api = new FakeControlPlane()
            .WithClient('acme', 'Acme')
            .WithTenant('acme-prod', 'acme', 'Acme Production')
            .WithHive('acme-hive', 'acme-prod', [true, false])
            .WithTenant('acme-dev', 'acme', 'Acme Dev')
        this.Host = new PortalTestHost(this.Api.AsClient(), wireRole)
        this.Dialogs = this.Host.UseDialogs()
        this.Clipboard = this.Host.UseClipboard()
        this.Host.Provider.register(TenantsSectionService.Key, (p) => new TenantsSectionService(p))
        this.Host.Provider.register(HivesSectionService.Key, (p) => new HivesSectionService(p))
        this.Rail = new TestRail(this.Host.Provider)
        this.Rail.Add(TenantsSectionService)
        this.Rail.Add(HivesSectionService)
    }

    public get Section(): TenantsSectionService
    {
        return this.Host.Provider.getRequired(TenantsSectionService.Key)
    }

    public get Content(): unknown
    {
        return this.Host.Host.Content
    }

    public async List(): Promise<TenantsPageViewModel>
    {
        this.Rail.Select(TenantsSectionService)
        await Tick.Settle()
        assert.ok(this.Content instanceof TenantsPageViewModel)
        return this.Content
    }

    public async Detail(id: string): Promise<TenantDetailPageViewModel>
    {
        const list = await this.List()
        list.OpenCommand.Execute(list.Rows.ToArray().find(r => r.Id === id))
        await Tick.Settle()
        assert.ok(this.Content instanceof TenantDetailPageViewModel)
        return this.Content
    }

    // Creates tenant initech-prod for client acme through the dialog; leaves
    // the section on the Owner password reveal.
    public async CreateTenant(): Promise<OwnerPasswordRevealPageViewModel>
    {
        const list = await this.List()
        list.NewCommand.Execute()
        await Tick.Settle()
        const dialog = this.Dialogs.Last as NewTenantDialogViewModel
        dialog.SelectedClient = dialog.Clients.Get(0)
        dialog.Id = 'initech-prod'
        dialog.DisplayName = 'Initech Production'
        dialog.OwnerEmail = 'owner@initech.test'
        dialog.ConfirmCommand.Execute()
        await Tick.Settle()
        assert.ok(this.Content instanceof OwnerPasswordRevealPageViewModel)
        return this.Content
    }
}

describe('Tenants section', () =>
{
    it('the list loads each tenant with its client and hive', async () =>
    {
        const fx = new TenantsFixture()
        const list = await fx.List()
        assert.equal(list.State, PageState.Populated)
        assert.equal(list.Rows.Count, 2)
        const prod = list.Rows.Get(0)
        assert.equal(prod?.DisplayName, 'Acme Production')
        assert.equal(prod?.ClientName, 'Acme')
        assert.equal(prod?.HiveName, 'Hive acme-hive')
        assert.equal(prod?.ConnectionLabel, 'Connected')
        assert.equal(prod?.EnvCountText, '2')
        assert.equal(list.Rows.Get(1)?.HiveName, 'No hive yet')
    })

    it('New tenant offers the clients and passes ownerEmail through CreateTenant', async () =>
    {
        const fx = new TenantsFixture()
        const list = await fx.List()
        list.NewCommand.Execute()
        await Tick.Settle()
        const dialog = fx.Dialogs.Last
        assert.ok(dialog instanceof NewTenantDialogViewModel)
        assert.deepEqual(dialog.Clients.ToArray().map(c => c.Label), ['Acme'])
        dialog.SelectedClient = dialog.Clients.Get(0)
        dialog.Id = 'Initech Prod'
        dialog.DisplayName = 'Initech Production'
        dialog.OwnerEmail = 'owner@initech.test'
        assert.notEqual(dialog.IdErrorText, '')
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
        dialog.Id = 'initech-prod'
        assert.equal(dialog.IdErrorText, '')
        assert.equal(dialog.ConfirmCommand.CanExecute(), true)
        dialog.ConfirmCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.CreatedTenants, [['initech-prod', 'acme', 'Initech Production', 'owner@initech.test']])
    })

    it('a created tenant reveals the Owner password once, on its own page', async () =>
    {
        const fx = new TenantsFixture()
        const reveal = await fx.CreateTenant()
        assert.equal(reveal.Value, fx.Api.OwnerPassword)
        assert.equal(reveal.Email, 'owner@initech.test')
        assert.equal(reveal.TenantId, 'initech-prod')
        assert.equal(fx.Section.Current, reveal)
    })

    it('dismissing the dialog while the create is in flight still reveals the Owner password', async () =>
    {
        const fx = new TenantsFixture()
        const list = await fx.List()
        list.NewCommand.Execute()
        await Tick.Settle()
        const dialog = fx.Dialogs.Last as NewTenantDialogViewModel
        assert.equal(fx.Dialogs.Shown[0].DismissOnScrimClick, false)
        dialog.SelectedClient = dialog.Clients.Get(0)
        dialog.Id = 'initech-prod'
        dialog.DisplayName = 'Initech Production'
        dialog.OwnerEmail = 'owner@initech.test'
        fx.Api.HoldCreates()
        dialog.ConfirmCommand.Execute()
        await Tick.Settle()
        fx.Dialogs.Dismiss()
        await Tick.Settle()
        fx.Api.Release()
        await Tick.Settle()
        const reveal = fx.Content
        assert.ok(reveal instanceof OwnerPasswordRevealPageViewModel)
        const revealed = fx.Api.OwnerPassword
        assert.equal(reveal.Value, revealed)
        // The fake itself holds the fixture value (reachable via the dialog's
        // session); rotate it so only a copy kept by the dialog would match.
        fx.Api.OwnerPassword = 'rotated'
        assert.equal(Inspect.ReachableStrings(dialog).includes(revealed), false)
    })

    it('Copy puts the password on the clipboard', async () =>
    {
        const fx = new TenantsFixture()
        const reveal = await fx.CreateTenant()
        reveal.CopyCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Clipboard, [fx.Api.OwnerPassword])
        assert.equal(reveal.CopyStatus, 'Copied.')
    })

    it('confirming is disabled until Saved; then the value is cleared and the tenant detail replaces the reveal', async () =>
    {
        const fx = new TenantsFixture()
        const reveal = await fx.CreateTenant()
        assert.equal(reveal.ConfirmSavedCommand.CanExecute(), false)
        reveal.ConfirmSavedCommand.Execute()
        assert.equal(fx.Content, reveal)
        assert.equal(reveal.Value, fx.Api.OwnerPassword)
        reveal.Saved = true
        assert.equal(reveal.ConfirmSavedCommand.CanExecute(), true)
        reveal.ConfirmSavedCommand.Execute()
        await Tick.Settle()
        assert.equal(reveal.Value, '')
        const detail: unknown = fx.Content
        assert.ok(detail instanceof TenantDetailPageViewModel)
        assert.equal(detail.Id, 'initech-prod')
        assert.equal(fx.Section.Current, detail)
        assert.equal(Inspect.PropertyValues(detail).includes(fx.Api.OwnerPassword), false)
        detail.BackCommand.Execute()
        assert.ok(fx.Content instanceof TenantsPageViewModel)
    })

    it('coming back through the rail shows tenants added elsewhere meanwhile', async () =>
    {
        const fx = new TenantsFixture()
        const list = await fx.List()
        assert.equal(list.Rows.Count, 2)
        fx.Rail.Select(HivesSectionService)
        await Tick.Settle()
        fx.Api.WithTenant('globex-prod', 'acme', 'Globex Production')
        fx.Rail.Select(TenantsSectionService)
        await Tick.Settle()
        assert.equal(fx.Content, list)
        assert.equal(list.State, PageState.Populated)
        assert.deepEqual(list.Rows.ToArray().map(r => r.Id).sort(), ['acme-dev', 'acme-prod', 'globex-prod'])
    })

    it('while a create is in flight New stays disabled, even after its dialog is dismissed; no Owner password is lost', async () =>
    {
        const fx = new TenantsFixture()
        const list = await fx.List()
        list.NewCommand.Execute()
        await Tick.Settle()
        const dialog = fx.Dialogs.Last as NewTenantDialogViewModel
        dialog.SelectedClient = dialog.Clients.Get(0)
        dialog.Id = 'initech-prod'
        dialog.DisplayName = 'Initech Production'
        dialog.OwnerEmail = 'owner@initech.test'
        fx.Api.HoldCreates()
        dialog.ConfirmCommand.Execute()
        await Tick.Settle()
        fx.Dialogs.Dismiss()
        await Tick.Settle()
        assert.equal(list.NewCommand.CanExecute(), false)
        list.NewCommand.Execute()
        await Tick.Settle()
        assert.equal(fx.Dialogs.Shown.length, 1)
        fx.Api.Release()
        await Tick.Settle()
        assert.deepEqual(fx.Api.CreatedTenants.map(t => t[0]), ['initech-prod'])
        const reveal = fx.Content
        assert.ok(reveal instanceof OwnerPasswordRevealPageViewModel)
        assert.equal(reveal.Value, fx.Api.OwnerPassword)
        assert.equal(list.NewCommand.CanExecute(), true)
    })

    it('leaving through the rail before confirming keeps the reveal as the current page', async () =>
    {
        const fx = new TenantsFixture()
        const reveal = await fx.CreateTenant()
        fx.Rail.Select(HivesSectionService)
        await Tick.Settle()
        assert.ok(fx.Content instanceof HivesPageViewModel)
        fx.Rail.Select(TenantsSectionService)
        assert.equal(fx.Content, reveal)
        assert.equal(reveal.Value, fx.Api.OwnerPassword)
    })

    it('a pending Owner password reveal is not dropped or covered by section navigation', async () =>
    {
        const fx = new TenantsFixture()
        const reveal = await fx.CreateTenant()
        assert.equal(reveal.HasPendingSecret, true)
        fx.Section.OpenTenant('acme-prod')
        fx.Section.Back()
        fx.Section.Replace(new TenantsPageViewModel(fx.Host.Session, fx.Section))
        await Tick.Settle()
        assert.equal(fx.Section.Current, reveal)
        assert.equal(fx.Content, reveal)
        assert.equal(reveal.Value, fx.Api.OwnerPassword)
        reveal.Saved = true
        reveal.ConfirmSavedCommand.Execute()
        await Tick.Settle()
        assert.equal(reveal.HasPendingSecret, false)
        assert.ok(fx.Content instanceof TenantDetailPageViewModel)
    })

    it('the reveal raises HasPendingSecret when its value is confirmed saved', async () =>
    {
        const fx = new TenantsFixture()
        const reveal = await fx.CreateTenant()
        const seen: Array<[unknown, unknown]> = []
        reveal.PropertyChanged('HasPendingSecret').subscribe(e => seen.push([e.oldValue, e.newValue]))
        reveal.Saved = true
        reveal.ConfirmSavedCommand.Execute()
        assert.deepEqual(seen, [[true, false]])
    })

    it('the tenant detail shows the hive binding and the observed environments, read-only', async () =>
    {
        const fx = new TenantsFixture()
        const detail = await fx.Detail('acme-prod')
        assert.equal(detail.State, PageState.Populated)
        assert.equal(detail.DisplayName, 'Acme Production')
        assert.equal(detail.ClientName, 'Acme')
        assert.equal(detail.HasHive, true)
        assert.equal(detail.HiveName, 'Hive acme-hive')
        assert.equal(detail.ConnectionLabel, 'Connected')
        assert.equal(detail.ClusterLabel, 'local / attach')
        assert.equal(detail.Observed.Rows.Count, 2)
        assert.equal(detail.Observed.Rows.Get(0)?.StatusLabel, 'Ready')
        assert.equal(detail.Observed.Rows.Get(1)?.StatusLabel, 'Not ready')
        assert.equal(Inspect.HasCommand(detail.Observed), false)
        assert.equal(Inspect.HasCommand(detail.Observed.Rows.Get(0) as object), false)
    })

    it('a tenant without a hive says so', async () =>
    {
        const fx = new TenantsFixture()
        const detail = await fx.Detail('acme-dev')
        assert.equal(detail.HasHive, false)
        assert.equal(detail.HiveName, 'No hive yet')
        assert.equal(detail.Observed.IsEmpty, true)
        assert.equal(detail.OpenHiveCommand.CanExecute(), false)
    })

    it('rail round-trip keeps the tenant detail', async () =>
    {
        const fx = new TenantsFixture()
        const detail = await fx.Detail('acme-prod')
        fx.Rail.Select(HivesSectionService)
        await Tick.Settle()
        assert.ok(fx.Content instanceof HivesPageViewModel)
        fx.Rail.Select(TenantsSectionService)
        assert.equal(fx.Content, detail)
    })

    it('the hive binding opens the hive detail in the Hives section', async () =>
    {
        const fx = new TenantsFixture()
        const detail = await fx.Detail('acme-prod')
        detail.OpenHiveCommand.Execute()
        await Tick.Settle()
        const hives = fx.Host.Provider.getRequired(HivesSectionService.Key)
        assert.equal(fx.Rail.Navigation.ActiveService, hives)
        assert.ok(fx.Content instanceof HiveDetailPageViewModel)
        assert.equal((fx.Content as HiveDetailPageViewModel).Id, 'acme-hive')
        hives.BackCommand.Execute()
        assert.ok(fx.Content instanceof HivesPageViewModel)
    })

    it('Delete asks for the tenant id and, on a match, deletes and returns to the list', async () =>
    {
        const fx = new TenantsFixture()
        const detail = await fx.Detail('acme-dev')
        detail.DeleteCommand.Execute()
        await Tick.Settle()
        const confirm = fx.Dialogs.Last
        assert.ok(confirm instanceof NameConfirmDialogViewModel)
        confirm.Typed = 'acme'
        assert.equal(confirm.ConfirmCommand.CanExecute(), false)
        confirm.Typed = 'acme-dev'
        confirm.ConfirmCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.Deleted, ['acme-dev'])
        const list = fx.Content
        assert.ok(list instanceof TenantsPageViewModel)
        assert.equal(list.Rows.Count, 1)
    })

    it('Observer: New and Delete are disabled and never open a dialog', async () =>
    {
        const fx = new TenantsFixture(OperatorContext.ReadOnlyWireRole)
        const list = await fx.List()
        assert.equal(list.NewCommand.CanExecute(), false)
        list.NewCommand.Execute()
        const detail = await fx.Detail('acme-prod')
        assert.equal(detail.DeleteCommand.CanExecute(), false)
        assert.notEqual(detail.DeniedReason, '')
        detail.DeleteCommand.Execute()
        await Tick.Settle()
        assert.equal(fx.Dialogs.Shown.length, 0)
    })
})
