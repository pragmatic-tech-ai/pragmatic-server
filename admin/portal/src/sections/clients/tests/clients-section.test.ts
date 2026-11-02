import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../../../api-client.js'
import { OperatorContext } from '../../../operator-context.js'
import { NameConfirmDialogViewModel } from '../../../shell/name-confirm-dialog-view-model.js'
import { PageState } from '../../../shell/portal-page-view-model.js'
import { FakeControlPlane, PortalTestHost, Tick, type FakeDialogService } from '../../../shell/tests/portal-test-fixtures.js'
import { ClientDetailPageViewModel } from '../client-detail-page-view-model.js'
import { ClientsPageViewModel } from '../clients-page-view-model.js'
import { ClientsSectionService } from '../clients-section-service.js'
import { NewClientDialogViewModel } from '../new-client-dialog-view-model.js'

// A Clients section over a fake control plane and fake dialogs.
class ClientsFixture
{
    public readonly Api: FakeControlPlane
    public readonly Host: PortalTestHost
    public readonly Dialogs: FakeDialogService
    public readonly Section: ClientsSectionService

    public constructor(api: FakeControlPlane, wireRole: string = OperatorContext.FullWireRole)
    {
        this.Api = api
        this.Host = new PortalTestHost(api.AsClient(), wireRole)
        this.Dialogs = this.Host.UseDialogs()
        this.Section = new ClientsSectionService(this.Host.Provider)
    }

    public static Seeded(wireRole?: string): ClientsFixture
    {
        const api = new FakeControlPlane()
            .WithClient('acme', 'Acme')
            .WithTenant('acme-prod', 'acme')
            .WithHive('acme-hive', 'acme-prod')
            .WithClient('globex', 'Globex')
        return new ClientsFixture(api, wireRole)
    }

    public async List(): Promise<ClientsPageViewModel>
    {
        this.Section.OnActivated()
        await Tick.Settle()
        assert.ok(this.Host.Host.Content instanceof ClientsPageViewModel)
        return this.Host.Host.Content
    }

    public async Detail(id: string): Promise<ClientDetailPageViewModel>
    {
        const list = await this.List()
        list.OpenCommand.Execute(list.Rows.ToArray().find(r => r.Id === id))
        await Tick.Settle()
        assert.ok(this.Host.Host.Content instanceof ClientDetailPageViewModel)
        return this.Host.Host.Content
    }
}

describe('Clients section', () =>
{
    it('the list loads one row per client with its counts', async () =>
    {
        const fx = ClientsFixture.Seeded()
        const list = await fx.List()
        assert.equal(list.State, PageState.Populated)
        assert.equal(list.Rows.Count, 2)
        const acme = list.Rows.Get(0)
        assert.equal(acme?.DisplayName, 'Acme')
        assert.equal(acme?.TenantCountText, '1')
        assert.equal(acme?.HiveCountText, '1')
        assert.equal(acme?.ConnectionSummary, '1 connected')
        assert.equal(acme?.ClientSinceLabel, '2026-10-01')
    })

    it('no clients -> Empty', async () =>
    {
        const fx = new ClientsFixture(new FakeControlPlane())
        const list = await fx.List()
        assert.equal(list.State, PageState.Empty)
    })

    it('OpenCommand presents the client detail for that row, and Back returns to the list', async () =>
    {
        const fx = ClientsFixture.Seeded()
        const list = await fx.List()
        list.Rows.Get(0)?.OpenCommand.Execute()
        await Tick.Settle()
        const detail = fx.Host.Host.Content
        assert.ok(detail instanceof ClientDetailPageViewModel)
        assert.equal(detail.Id, 'acme')
        assert.equal(detail.State, PageState.Populated)
        assert.equal(detail.DisplayName, 'Acme')
        assert.equal(detail.Tenants.Count, 1)
        assert.equal(detail.Tenants.Get(0)?.HiveName, 'Hive acme-hive')
        assert.equal(detail.Tenants.Get(0)?.ConnectionLabel, 'Connected')
        detail.BackCommand.Execute()
        assert.equal(fx.Host.Host.Content, list)
    })

    it('a missing client shows the Error state', async () =>
    {
        const fx = ClientsFixture.Seeded()
        await fx.List()
        fx.Section.OpenClient('nobody')
        await Tick.Settle()
        const detail = fx.Host.Host.Content as ClientDetailPageViewModel
        assert.equal(detail.State, PageState.Error)
        assert.match(detail.ErrorText, /nobody/)
    })

    it('New opens a NewClientDialogViewModel; confirm creates the client and refreshes the list', async () =>
    {
        const fx = ClientsFixture.Seeded()
        const list = await fx.List()
        list.NewCommand.Execute()
        await Tick.Settle()
        assert.equal(fx.Dialogs.Shown.length, 1)
        const dialog = fx.Dialogs.Last
        assert.ok(dialog instanceof NewClientDialogViewModel)
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
        dialog.Id = 'initech'
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
        dialog.DisplayName = 'Initech'
        assert.equal(dialog.ConfirmCommand.CanExecute(), true)
        dialog.ConfirmCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.CreatedClients, [['initech', 'Initech', undefined]])
        assert.equal(fx.Dialogs.IsOpen, false)
        assert.equal(list.Rows.Count, 3)
        assert.equal(fx.Host.Host.Content, list)
    })

    it('a subscription reference is passed through, trimmed', async () =>
    {
        const fx = ClientsFixture.Seeded()
        const list = await fx.List()
        list.NewCommand.Execute()
        await Tick.Settle()
        const dialog = fx.Dialogs.Last as NewClientDialogViewModel
        dialog.Id = ' initech '
        dialog.DisplayName = 'Initech'
        dialog.SubscriptionRef = ' sub-42 '
        await dialog.Confirm()
        assert.deepEqual(fx.Api.CreatedClients, [['initech', 'Initech', 'sub-42']])
    })

    it('a refused create stays in the dialog with the reason', async () =>
    {
        const fx = ClientsFixture.Seeded()
        const list = await fx.List()
        list.NewCommand.Execute()
        await Tick.Settle()
        const dialog = fx.Dialogs.Last as NewClientDialogViewModel
        dialog.Id = 'acme'
        dialog.DisplayName = 'Acme again'
        fx.Api.Failure = new ApiError(409, 'client acme already exists')
        await dialog.Confirm()
        assert.equal(fx.Dialogs.IsOpen, true)
        assert.equal(dialog.ErrorText, 'client acme already exists')
        assert.equal(dialog.IsBusy, false)
    })

    it('a 401 from the create expires the session and closes the dialog', async () =>
    {
        const fx = ClientsFixture.Seeded()
        const list = await fx.List()
        list.NewCommand.Execute()
        await Tick.Settle()
        const dialog = fx.Dialogs.Last as NewClientDialogViewModel
        dialog.Id = 'initech'
        dialog.DisplayName = 'Initech'
        fx.Api.Failure = new ApiError(ApiError.UnauthorizedStatus, 'expired')
        await dialog.Confirm()
        assert.equal(fx.Host.Reloader.Count, 1)
        assert.equal(fx.Dialogs.IsOpen, false)
    })

    it('Cancel closes the dialog without creating anything', async () =>
    {
        const fx = ClientsFixture.Seeded()
        const list = await fx.List()
        list.NewCommand.Execute()
        await Tick.Settle()
        const dialog = fx.Dialogs.Last as NewClientDialogViewModel
        dialog.CancelCommand.Execute()
        await Tick.Settle()
        assert.equal(fx.Dialogs.IsOpen, false)
        assert.deepEqual(fx.Api.CreatedClients, [])
    })

    it('Delete asks for the client id; a mismatch keeps confirm disabled; a match deletes and returns to the list', async () =>
    {
        const fx = ClientsFixture.Seeded()
        const detail = await fx.Detail('globex')
        detail.DeleteCommand.Execute()
        await Tick.Settle()
        const confirm = fx.Dialogs.Last
        assert.ok(confirm instanceof NameConfirmDialogViewModel)
        assert.equal(confirm.Expected, 'globex')
        confirm.Typed = 'globe'
        assert.equal(confirm.IsMatch, false)
        assert.equal(confirm.ConfirmCommand.CanExecute(), false)
        confirm.ConfirmCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.Deleted, [])
        confirm.Typed = 'globex'
        assert.equal(confirm.IsMatch, true)
        assert.equal(confirm.ConfirmCommand.CanExecute(), true)
        confirm.ConfirmCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.Deleted, ['globex'])
        const list = fx.Host.Host.Content
        assert.ok(list instanceof ClientsPageViewModel)
        assert.equal(fx.Section.Current, list)
        assert.equal(list.Rows.Count, 1)
    })

    it('a refused delete stays in the confirm dialog and on the detail', async () =>
    {
        const fx = ClientsFixture.Seeded()
        const detail = await fx.Detail('acme')
        detail.DeleteCommand.Execute()
        await Tick.Settle()
        const confirm = fx.Dialogs.Last as NameConfirmDialogViewModel
        confirm.Typed = 'acme'
        fx.Api.Failure = new ApiError(409, 'client acme still has tenants')
        await confirm.Confirm()
        assert.equal(confirm.ErrorText, 'client acme still has tenants')
        assert.equal(fx.Dialogs.IsOpen, true)
        assert.equal(fx.Section.Current, detail)
    })

    it('Observer: New and Delete are disabled, never open a dialog, and the reason is bindable', async () =>
    {
        const fx = ClientsFixture.Seeded(OperatorContext.ReadOnlyWireRole)
        const list = await fx.List()
        assert.equal(list.CanMutate, false)
        assert.notEqual(list.DeniedReason, '')
        assert.equal(list.NewCommand.CanExecute(), false)
        list.NewCommand.Execute()
        const detail = await fx.Detail('acme')
        assert.equal(detail.DeleteCommand.CanExecute(), false)
        detail.DeleteCommand.Execute()
        await Tick.Settle()
        assert.equal(fx.Dialogs.Shown.length, 0)
    })
})
