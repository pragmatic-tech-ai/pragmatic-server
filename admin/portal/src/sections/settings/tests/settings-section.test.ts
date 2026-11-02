import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OperatorContext } from '../../../operator-context.js'
import { PageState } from '../../../shell/portal-page-view-model.js'
import { FakeControlPlane, Inspect, PortalTestHost, Tick, type FakeDialogService } from '../../../shell/tests/portal-test-fixtures.js'
import { NameConfirmDialogViewModel } from '../../../shell/name-confirm-dialog-view-model.js'
import { InviteOperatorDialogViewModel } from '../invite-operator-dialog-view-model.js'
import { OperatorDetailPageViewModel } from '../operator-detail-page-view-model.js'
import { OperatorPasswordRevealPageViewModel } from '../operator-password-reveal-page-view-model.js'
import { SettingsPageViewModel } from '../settings-page-view-model.js'
import { SettingsSectionService } from '../settings-section-service.js'

// A Settings section over a fake control plane and fake dialogs.
class SettingsFixture
{
    public static readonly InvitePassword = 'fixture-invite-password'

    public readonly Api = new FakeControlPlane()
    public readonly Host: PortalTestHost
    public readonly Dialogs: FakeDialogService
    public readonly Section: SettingsSectionService

    public constructor(wireRole: string = OperatorContext.FullWireRole)
    {
        this.Api.Operators = [
            { email: 'zed@example.test', role: 'readonly' },
            { email: 'amy@example.test', role: 'full', disabled: true },
        ]
        // As the control plane does: the roster is Full-only, even to read.
        this.Api.DenyOperators = wireRole !== OperatorContext.FullWireRole
        this.Host = new PortalTestHost(this.Api.AsClient(), wireRole)
        this.Dialogs = this.Host.UseDialogs()
        this.Clipboard = this.Host.UseClipboard()
        this.Section = new SettingsSectionService(this.Host.Provider)
    }

    public readonly Clipboard: string[]

    public get Content(): unknown
    {
        return this.Host.Host.Content
    }

    // Opens the roster row for `email`.
    public async Operator(email: string): Promise<OperatorDetailPageViewModel>
    {
        const page = await this.Page()
        page.Operators.ToArray().find(o => o.Email === email)?.OpenCommand.Execute()
        await Tick.Settle()
        assert.ok(this.Content instanceof OperatorDetailPageViewModel)
        return this.Content
    }

    public async Page(): Promise<SettingsPageViewModel>
    {
        this.Section.OnActivated()
        await Tick.Settle()
        const content = this.Host.Host.Content
        assert.ok(content instanceof SettingsPageViewModel)
        return content
    }
}

describe('Settings section', () =>
{
    it('Profile shows the session email and role', async () =>
    {
        const fx = new SettingsFixture()
        const page = await fx.Page()
        assert.equal(page.Email, PortalTestHost.Email)
        assert.equal(page.RoleLabel, 'Operator')
        const observer = await new SettingsFixture(OperatorContext.ReadOnlyWireRole).Page()
        assert.equal(observer.RoleLabel, 'Observer')
    })

    it('the operator roster loads sorted, with role and status', async () =>
    {
        const fx = new SettingsFixture()
        const page = await fx.Page()
        assert.equal(page.State, PageState.Populated)
        assert.deepEqual(page.Operators.ToArray().map(o => [o.Email, o.RoleLabel, o.StatusLabel]), [
            ['amy@example.test', 'Operator', 'Disabled'],
            ['zed@example.test', 'Observer', 'Active'],
        ])
        assert.equal(page.HasOperators, true)
    })

    it('Invite opens a dialog and calls CreateOperator; the password is cleared afterwards', async () =>
    {
        const fx = new SettingsFixture()
        const page = await fx.Page()
        page.InviteCommand.Execute()
        await Tick.Settle()
        const dialog = fx.Dialogs.Last
        assert.ok(dialog instanceof InviteOperatorDialogViewModel)
        assert.equal(dialog.SelectedRole?.Value, 'readonly')
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
        dialog.Email = ' new@example.test '
        dialog.Password = SettingsFixture.InvitePassword
        dialog.SelectedRole = dialog.Roles.ToArray().find(r => r.Value === 'full')
        assert.equal(dialog.ConfirmCommand.CanExecute(), true)
        dialog.ConfirmCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.CreatedOperators, [['new@example.test', SettingsFixture.InvitePassword, 'full']])
        assert.equal(fx.Dialogs.IsOpen, false)
        assert.equal(dialog.Password, '')
        // Its own fields and getters (the fake control plane behind the session records it by design).
        assert.equal(Inspect.PropertyValues(dialog).includes(SettingsFixture.InvitePassword), false)
        assert.ok(page.Operators.ToArray().some(o => o.Email === 'new@example.test'))
    })

    it('Observer: Invite is disabled and never opens a dialog', async () =>
    {
        const fx = new SettingsFixture(OperatorContext.ReadOnlyWireRole)
        const page = await fx.Page()
        assert.equal(page.InviteCommand.CanExecute(), false)
        assert.notEqual(page.DeniedReason, '')
        page.InviteCommand.Execute()
        await Tick.Settle()
        assert.equal(fx.Dialogs.Shown.length, 0)
    })

    it('Observer: the roster is denied, not fetched; the profile still shows', async () =>
    {
        const fx = new SettingsFixture(OperatorContext.ReadOnlyWireRole)
        const page = await fx.Page()
        assert.equal(page.State, PageState.Populated)
        assert.equal(fx.Api.OperatorListCalls, 0)
        assert.equal(page.IsRosterDenied, true)
        assert.equal(page.HasOperators, false)
        assert.equal(page.HasNoOperators, false)
        assert.equal(page.Email, PortalTestHost.Email)
    })

    it('Operator: the roster is fetched and not denied', async () =>
    {
        const fx = new SettingsFixture()
        const page = await fx.Page()
        assert.equal(fx.Api.OperatorListCalls, 1)
        assert.equal(page.IsRosterDenied, false)
    })

    it('roster -> operator detail with email, role and status; Back returns', async () =>
    {
        const fx = new SettingsFixture()
        const detail = await fx.Operator('zed@example.test')
        assert.equal(detail.State, PageState.Populated)
        assert.equal(detail.Email, 'zed@example.test')
        assert.equal(detail.RoleLabel, 'Observer')
        assert.equal(detail.StatusLabel, 'Active')
        assert.equal(detail.SelectedRole?.Value, 'readonly')
        detail.BackCommand.Execute()
        assert.ok(fx.Content instanceof SettingsPageViewModel)
    })

    it('Change role writes the chosen role; it is enabled only for a different role', async () =>
    {
        const fx = new SettingsFixture()
        const detail = await fx.Operator('zed@example.test')
        assert.equal(detail.ChangeRoleCommand.CanExecute(), false)
        detail.SelectedRole = detail.Roles.ToArray().find(r => r.Value === 'full')
        assert.equal(detail.ChangeRoleCommand.CanExecute(), true)
        detail.ChangeRoleCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.OperatorCalls, ['SetOperatorRole zed@example.test full'])
        assert.equal(detail.RoleLabel, 'Operator')
    })

    it('after a role change, Back shows the roster reloaded with the new role', async () =>
    {
        const fx = new SettingsFixture()
        const detail = await fx.Operator('zed@example.test')
        detail.SelectedRole = detail.Roles.ToArray().find(r => r.Value === 'full')
        detail.ChangeRoleCommand.Execute()
        await Tick.Settle()
        detail.BackCommand.Execute()
        await Tick.Settle()
        const page = fx.Content
        assert.ok(page instanceof SettingsPageViewModel)
        assert.equal(page.Operators.ToArray().find(o => o.Email === 'zed@example.test')?.RoleLabel, 'Operator')
    })

    it('Disable / Enable toggles the account', async () =>
    {
        const fx = new SettingsFixture()
        const detail = await fx.Operator('amy@example.test')
        assert.equal(detail.ToggleDisabledLabel, 'Enable operator')
        detail.ToggleDisabledCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.OperatorCalls, ['SetOperatorDisabled amy@example.test false'])
        assert.equal(detail.StatusLabel, 'Active')
        assert.equal(detail.ToggleDisabledLabel, 'Disable operator')
    })

    it('Revoke sessions asks for the email first', async () =>
    {
        const fx = new SettingsFixture()
        const detail = await fx.Operator('zed@example.test')
        detail.RevokeSessionsCommand.Execute()
        await Tick.Settle()
        const confirm = fx.Dialogs.Last
        assert.ok(confirm instanceof NameConfirmDialogViewModel)
        assert.equal(confirm.ConfirmLabel, 'Revoke sessions')
        confirm.Typed = 'zed@example.test'
        confirm.ConfirmCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.OperatorCalls, ['RevokeOperatorSessions zed@example.test'])
        assert.equal(fx.Content, detail)
    })

    it('Reset password asks for the email, then shows the new password once on a reveal page', async () =>
    {
        const fx = new SettingsFixture()
        const detail = await fx.Operator('zed@example.test')
        detail.ResetPasswordCommand.Execute()
        await Tick.Settle()
        const confirm = fx.Dialogs.Last as NameConfirmDialogViewModel
        assert.equal(confirm.ConfirmLabel, 'Reset password')
        confirm.Typed = 'zed@example.test'
        confirm.ConfirmCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.OperatorCalls, ['ResetOperatorPassword zed@example.test'])
        const reveal = fx.Content
        assert.ok(reveal instanceof OperatorPasswordRevealPageViewModel)
        assert.equal(reveal.Email, 'zed@example.test')
        assert.equal(reveal.Value, fx.Api.ResetPassword)
        // The detail page's own fields and getters never hold it (the fake control plane behind the session does).
        assert.equal(Inspect.PropertyValues(detail).includes(fx.Api.ResetPassword), false)
        reveal.CopyCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Clipboard, [fx.Api.ResetPassword])
        // While pending, section navigation neither drops nor covers the reveal.
        assert.equal(reveal.HasPendingSecret, true)
        await fx.Section.BackAndRefresh()
        fx.Section.Present(detail)
        assert.equal(fx.Content, reveal)
        assert.equal(reveal.Value, fx.Api.ResetPassword)
        assert.equal(reveal.ConfirmSavedCommand.CanExecute(), false)
        reveal.Saved = true
        reveal.ConfirmSavedCommand.Execute()
        await Tick.Settle()
        assert.equal(reveal.Value, '')
        assert.equal(fx.Content, detail)
    })

    it('while a reset is in flight every operator command stays disabled, even after its dialog is dismissed', async () =>
    {
        const fx = new SettingsFixture()
        const detail = await fx.Operator('zed@example.test')
        detail.ResetPasswordCommand.Execute()
        await Tick.Settle()
        const confirm = fx.Dialogs.Last as NameConfirmDialogViewModel
        confirm.Typed = 'zed@example.test'
        fx.Api.HoldCreates()
        confirm.ConfirmCommand.Execute()
        await Tick.Settle()
        fx.Dialogs.Dismiss()
        await Tick.Settle()
        for (const command of [detail.ChangeRoleCommand, detail.ToggleDisabledCommand, detail.RevokeSessionsCommand, detail.ResetPasswordCommand])
        {
            assert.equal(command.CanExecute(), false)
        }
        detail.ResetPasswordCommand.Execute()
        await Tick.Settle()
        assert.equal(fx.Dialogs.Shown.length, 1)
        fx.Api.Release()
        await Tick.Settle()
        assert.deepEqual(fx.Api.OperatorCalls, ['ResetOperatorPassword zed@example.test'])
        const reveal = fx.Content
        assert.ok(reveal instanceof OperatorPasswordRevealPageViewModel)
        assert.equal(reveal.Value, fx.Api.ResetPassword)
        assert.equal(detail.ResetPasswordCommand.CanExecute(), true)
    })

    it('Observer: every operator-management command is disabled and opens no dialog', async () =>
    {
        const fx = new SettingsFixture(OperatorContext.ReadOnlyWireRole)
        fx.Section.OnActivated()
        fx.Section.OpenOperator('zed@example.test')
        await Tick.Settle()
        const detail = fx.Content
        assert.ok(detail instanceof OperatorDetailPageViewModel)
        for (const command of [detail.ChangeRoleCommand, detail.ToggleDisabledCommand, detail.RevokeSessionsCommand, detail.ResetPasswordCommand])
        {
            assert.equal(command.CanExecute(), false)
            command.Execute()
        }
        await Tick.Settle()
        assert.equal(fx.Dialogs.Shown.length, 0)
        assert.deepEqual(fx.Api.OperatorCalls, [])
        assert.equal(fx.Api.OperatorListCalls, 0)
    })
})
