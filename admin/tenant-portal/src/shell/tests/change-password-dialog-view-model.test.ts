import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TenantApiError } from '../../tenant-api-client.js'
import { ChangePasswordDialogViewModel } from '../change-password-dialog-view-model.js'
import { FakeTenantApi, TenantTestHost, type FakeDialogService } from './tenant-test-fixtures.js'

class TenantPasswordKit
{
    public static readonly Current = 'current-password'
    public static readonly Next = 'a-new-password-1'
    public static readonly NoCapabilities = { envs: false, adopt: false, access: false, settings: false }

    public static Fill(dialog: ChangePasswordDialogViewModel, current: string = TenantPasswordKit.Current, next: string = TenantPasswordKit.Next, confirm: string = next): void
    {
        dialog.CurrentPassword = current
        dialog.NewPassword = next
        dialog.ConfirmPassword = confirm
    }

    public static Host(capabilities = TenantTestHost.AllCapabilities): { api: FakeTenantApi; host: TenantTestHost; dialogs: FakeDialogService }
    {
        const api = new FakeTenantApi()
        const host = new TenantTestHost(api, capabilities)
        return { api, host, dialogs: host.UseDialogs() }
    }

    public static async Settle(): Promise<void>
    {
        for (let i = 0; i < 10; i++)
        {
            await new Promise(resolve => setImmediate(resolve))
        }
    }
}

describe('Tenant ChangePasswordDialogViewModel', () =>
{
    it('Confirm needs the current password, a new one of at least 12 characters that differs from it, and a matching confirmation', () =>
    {
        const { host, dialogs } = TenantPasswordKit.Host()
        const dialog = new ChangePasswordDialogViewModel(host.Session, dialogs)
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
        TenantPasswordKit.Fill(dialog)
        assert.equal(dialog.ConfirmCommand.CanExecute(), true)
        TenantPasswordKit.Fill(dialog, TenantPasswordKit.Current, 'short-pw')
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
        assert.equal(dialog.NewPasswordText, 'Use at least 12 characters.')
        TenantPasswordKit.Fill(dialog, TenantPasswordKit.Current, TenantPasswordKit.Next, 'something-else-1')
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
        assert.equal(dialog.MismatchText, 'The two new passwords do not match.')
        TenantPasswordKit.Fill(dialog, TenantPasswordKit.Next, TenantPasswordKit.Next)
        assert.equal(dialog.NewPasswordText, 'The new password must differ from the current one.')
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
    })

    it('needs no admin permission: a user without any capability may change their own password', async () =>
    {
        const { api, host, dialogs } = TenantPasswordKit.Host(TenantPasswordKit.NoCapabilities)
        const dialog = new ChangePasswordDialogViewModel(host.Session, dialogs)
        const opened = dialog.Open('Change your password')
        TenantPasswordKit.Fill(dialog)
        assert.equal(dialog.ConfirmCommand.CanExecute(), true)
        dialog.ConfirmCommand.Execute()
        await TenantPasswordKit.Settle()
        assert.deepEqual(await opened, { ok: true, otherSessionsEnded: true })
        assert.deepEqual(api.Calls.filter(c => c[0] === 'ChangeOwnPassword'), [['ChangeOwnPassword', TenantPasswordKit.Current, TenantPasswordKit.Next, TenantPasswordKit.Next]])
    })

    it('clears every password once it closes: changed, cancelled, or dismissed', async () =>
    {
        const { host, dialogs } = TenantPasswordKit.Host()
        for (const close of ['confirm', 'cancel', 'dismiss'])
        {
            const dialog = new ChangePasswordDialogViewModel(host.Session, dialogs)
            const opened = dialog.Open('Change your password')
            TenantPasswordKit.Fill(dialog)
            if (close === 'confirm')
            {
                dialog.ConfirmCommand.Execute()
            }
            else if (close === 'cancel')
            {
                dialog.CancelCommand.Execute()
            }
            else
            {
                dialogs.Dismiss()
            }
            await TenantPasswordKit.Settle()
            await opened
            assert.deepEqual([dialog.CurrentPassword, dialog.NewPassword, dialog.ConfirmPassword], ['', '', ''], close)
        }
    })

    it('a wrong current password (403) or a throttled attempt (429) keeps the dialog open with the reason; the session does not expire', async () =>
    {
        const { api, host, dialogs } = TenantPasswordKit.Host()
        for (const failure of [new TenantApiError(403, 'The current password is not correct.'), new TenantApiError(429, 'Too many attempts; try again later.')])
        {
            api.FailOn.set('ChangeOwnPassword', failure)
            const dialog = new ChangePasswordDialogViewModel(host.Session, dialogs)
            void dialog.Open('Change your password')
            TenantPasswordKit.Fill(dialog)
            dialog.ConfirmCommand.Execute()
            await TenantPasswordKit.Settle()
            assert.equal(dialog.ErrorText, failure.message)
            assert.equal(dialogs.IsOpen, true)
            dialogs.Dismiss()
            await TenantPasswordKit.Settle()
        }
        assert.equal(host.Reloader.Count, 0)
    })

    it('the session Change password command opens the dialog and, once changed, says so in the header (or the warning)', async () =>
    {
        const { api, host, dialogs } = TenantPasswordKit.Host(TenantPasswordKit.NoCapabilities)
        assert.equal(host.Session.ChangePasswordCommand.CanExecute(), true)
        let done = host.Session.ChangePassword()
        await TenantPasswordKit.Settle()
        let dialog = dialogs.Last as ChangePasswordDialogViewModel
        assert.ok(dialog instanceof ChangePasswordDialogViewModel)
        assert.equal(dialog.Email, 'owner@example.test')
        TenantPasswordKit.Fill(dialog)
        dialog.ConfirmCommand.Execute()
        await done
        assert.equal(host.Session.AccountNotice, 'Password changed. Your other sessions were signed out.')

        api.PasswordReply = { ok: true, otherSessionsEnded: false, warning: 'Your password is changed, but your other sessions could not be signed out.' }
        done = host.Session.ChangePassword()
        await TenantPasswordKit.Settle()
        dialog = dialogs.Last as ChangePasswordDialogViewModel
        TenantPasswordKit.Fill(dialog)
        dialog.ConfirmCommand.Execute()
        await done
        assert.equal(host.Session.AccountNotice, api.PasswordReply.warning)
    })

    it('a sign-in without an email cannot change its password here: the command is off and says why', () =>
    {
        const { api, host } = TenantPasswordKit.Host()
        assert.equal(host.Session.ChangePasswordDeniedReason, '')
        host.Session.Initialize(api.AsClient(), { tenantId: 'tenant-1', principalId: 'principal-1' }, undefined, host.Reloader)
        assert.equal(host.Session.CanChangePassword, false)
        assert.equal(host.Session.ChangePasswordCommand.CanExecute(), false)
        assert.equal(host.Session.ChangePasswordDeniedReason, 'This sign-in carries no email, so its password cannot be changed here.')
    })

    it('while the change is submitting a 401 elsewhere does not expire the session; once done it is checked once and kept', async () =>
    {
        const { api, host, dialogs } = TenantPasswordKit.Host()
        let release: () => void = () => undefined
        api.PasswordChangeHold = new Promise<void>(res => { release = res })
        const dialog = new ChangePasswordDialogViewModel(host.Session, dialogs)
        const opened = dialog.Open('Change your password')
        TenantPasswordKit.Fill(dialog)
        dialog.ConfirmCommand.Execute()
        await TenantPasswordKit.Settle()
        host.Session.Expire()
        assert.equal(host.Reloader.Count, 0)
        release()
        await opened
        await TenantPasswordKit.Settle()
        assert.equal(api.Count('Session'), 1)
        assert.equal(host.Reloader.Count, 0)
    })

    it('a 401 during the change whose session is really gone afterwards does expire, once the change is done', async () =>
    {
        const { api, host, dialogs } = TenantPasswordKit.Host()
        let release: () => void = () => undefined
        api.PasswordChangeHold = new Promise<void>(res => { release = res })
        api.SessionAlive = false
        const dialog = new ChangePasswordDialogViewModel(host.Session, dialogs)
        const opened = dialog.Open('Change your password')
        TenantPasswordKit.Fill(dialog)
        dialog.ConfirmCommand.Execute()
        await TenantPasswordKit.Settle()
        host.Session.Expire()
        release()
        await opened
        await TenantPasswordKit.Settle()
        assert.equal(host.Reloader.Count, 1)
    })
})
