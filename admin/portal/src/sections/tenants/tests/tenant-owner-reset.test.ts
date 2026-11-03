import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../../../api-client.js'
import { OperatorContext } from '../../../operator-context.js'
import { NameConfirmDialogViewModel } from '../../../shell/name-confirm-dialog-view-model.js'
import { PendingSecret } from '../../../shell/holds-pending-secret.js'
import { FakeControlPlane, PortalTestHost, TestRail, Tick, type FakeDialogService } from '../../../shell/tests/portal-test-fixtures.js'
import { OwnerPasswordKind, OwnerPasswordRevealPageViewModel } from '../owner-password-reveal-page-view-model.js'
import { TenantDetailPageViewModel } from '../tenant-detail-page-view-model.js'
import { TenantsPageViewModel } from '../tenants-page-view-model.js'
import { TenantsSectionService } from '../tenants-section-service.js'

// The Tenants section behind a real rail, over a fake control plane.
class ResetFixture
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
        this.Host = new PortalTestHost(this.Api.AsClient(), wireRole)
        this.Dialogs = this.Host.UseDialogs()
        this.Clipboard = this.Host.UseClipboard()
        this.Host.Provider.register(TenantsSectionService.Key, (p) => new TenantsSectionService(p))
        this.Rail = new TestRail(this.Host.Provider)
        this.Rail.Add(TenantsSectionService)
    }

    public get Content(): unknown
    {
        return this.Host.Host.Content
    }

    public get Section(): TenantsSectionService
    {
        return this.Host.Provider.getRequired(TenantsSectionService.Key)
    }

    public async Detail(): Promise<TenantDetailPageViewModel>
    {
        this.Rail.Select(TenantsSectionService)
        await Tick.Settle()
        assert.ok(this.Content instanceof TenantsPageViewModel)
        this.Content.OpenCommand.Execute(this.Content.Rows.Get(0))
        await Tick.Settle()
        assert.ok(this.Content instanceof TenantDetailPageViewModel)
        return this.Content
    }

    // Runs Reset Owner password, types the tenant id and confirms; returns the dialog.
    public async Confirmed(detail: TenantDetailPageViewModel): Promise<NameConfirmDialogViewModel>
    {
        detail.ResetOwnerPasswordCommand.Execute()
        await Tick.Settle()
        const confirm = this.Dialogs.Last
        assert.ok(confirm instanceof NameConfirmDialogViewModel)
        confirm.Typed = 'acme-prod'
        confirm.ConfirmCommand.Execute()
        await Tick.Settle()
        return confirm
    }
}

describe('Tenant Owner password reset', () =>
{
    it('asks for the tenant id, warning the old password stops working at once', async () =>
    {
        const fx = new ResetFixture()
        const detail = await fx.Detail()
        detail.ResetOwnerPasswordCommand.Execute()
        await Tick.Settle()
        const confirm = fx.Dialogs.Last
        assert.ok(confirm instanceof NameConfirmDialogViewModel)
        assert.match(confirm.Message, /old password stops working immediately/)
        assert.equal(confirm.ConfirmLabel, 'Reset')
        fx.Dialogs.Dismiss()
        await Tick.Settle()
        assert.deepEqual(fx.Api.OwnerResets, [])
    })

    it('a confirmed reset reveals the new password once with the Owner email, held until saved, then returns to the tenant', async () =>
    {
        const fx = new ResetFixture()
        const detail = await fx.Detail()
        await fx.Confirmed(detail)
        assert.deepEqual(fx.Api.OwnerResets, ['acme-prod'])
        const reveal = fx.Content
        assert.ok(reveal instanceof OwnerPasswordRevealPageViewModel)
        assert.equal(reveal.Kind, OwnerPasswordKind.Reset)
        assert.equal(reveal.TenantId, 'acme-prod')
        assert.equal(reveal.Email, fx.Api.OwnerResetEmail)
        assert.equal(reveal.Value, fx.Api.OwnerResetPassword)
        assert.equal(reveal.Heading, 'Owner password reset')
        assert.equal(PendingSecret.IsHeldBy(reveal), true)
        // The leave guard: Back is refused while the password is unsaved.
        fx.Section.BackCommand.Execute()
        assert.equal(fx.Content, reveal)
        reveal.CopyCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Clipboard, [fx.Api.OwnerResetPassword])
        reveal.Saved = true
        reveal.ConfirmSavedCommand.Execute()
        await Tick.Settle()
        assert.equal(reveal.Value, '')
        assert.equal(fx.Content, detail)
    })

    it('a refused reset shows its reason in the dialog and reveals nothing', async () =>
    {
        const fx = new ResetFixture()
        fx.Api.OwnerResetFailure = new ApiError(409, 'This tenant has no Owner recorded (it was created without one), so there is no Owner password to reset.')
        const detail = await fx.Detail()
        const confirm = await fx.Confirmed(detail)
        assert.match(confirm.ErrorText, /no Owner recorded/)
        assert.ok(!(fx.Content instanceof OwnerPasswordRevealPageViewModel))
    })

    it('the creation reveal keeps its heading and goes on to the tenant', async () =>
    {
        const reveal = new OwnerPasswordRevealPageViewModel({ Clipboard: undefined } as unknown as TenantsSectionService, 't1', 'o@x.test', 'pw', OwnerPasswordKind.Created)
        assert.equal(reveal.Heading, 'Tenant created')
        assert.equal(reveal.ContinueLabel, 'Continue to the tenant')
    })

    it('Observer: Reset Owner password is disabled and never opens a dialog', async () =>
    {
        const fx = new ResetFixture(OperatorContext.ReadOnlyWireRole)
        const detail = await fx.Detail()
        assert.equal(detail.ResetOwnerPasswordCommand.CanExecute(), false)
        detail.ResetOwnerPasswordCommand.Execute()
        await Tick.Settle()
        assert.equal(fx.Dialogs.Shown.length, 0)
    })
})
