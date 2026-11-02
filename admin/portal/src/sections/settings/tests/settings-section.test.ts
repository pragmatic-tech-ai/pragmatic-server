import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OperatorContext } from '../../../operator-context.js'
import { PageState } from '../../../shell/portal-page-view-model.js'
import { FakeControlPlane, Inspect, PortalTestHost, Tick, type FakeDialogService } from '../../../shell/tests/portal-test-fixtures.js'
import { InviteOperatorDialogViewModel } from '../invite-operator-dialog-view-model.js'
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
        this.Host = new PortalTestHost(this.Api.AsClient(), wireRole)
        this.Dialogs = this.Host.UseDialogs()
        this.Section = new SettingsSectionService(this.Host.Provider)
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
})
