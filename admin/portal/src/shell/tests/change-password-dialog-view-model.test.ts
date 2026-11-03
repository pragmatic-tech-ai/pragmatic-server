import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../../api-client.js'
import { OperatorContext } from '../../operator-context.js'
import { ChangePasswordDialogViewModel } from '../change-password-dialog-view-model.js'
import { FakeControlPlane, PortalTestHost, Tick, type FakeDialogService } from './portal-test-fixtures.js'

class PasswordKit
{
    public static readonly Current = 'current-password'
    public static readonly Next = 'a-new-password-1'

    public static Fill(dialog: ChangePasswordDialogViewModel, current: string = PasswordKit.Current, next: string = PasswordKit.Next, confirm: string = next): void
    {
        dialog.CurrentPassword = current
        dialog.NewPassword = next
        dialog.ConfirmPassword = confirm
    }

    public static Host(wireRole: string = OperatorContext.FullWireRole): { api: FakeControlPlane; host: PortalTestHost; dialogs: FakeDialogService }
    {
        const api = new FakeControlPlane()
        const host = new PortalTestHost(api.AsClient(), wireRole)
        return { api, host, dialogs: host.UseDialogs() }
    }
}

describe('ChangePasswordDialogViewModel', () =>
{
    it('Confirm needs the current password, a new one of at least 12 characters that differs from it, and a matching confirmation', () =>
    {
        const { host, dialogs } = PasswordKit.Host()
        const dialog = new ChangePasswordDialogViewModel(host.Session, dialogs)
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
        PasswordKit.Fill(dialog)
        assert.equal(dialog.ConfirmCommand.CanExecute(), true)
        PasswordKit.Fill(dialog, '', PasswordKit.Next)
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
        PasswordKit.Fill(dialog, PasswordKit.Current, 'short-pw')
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
        PasswordKit.Fill(dialog, PasswordKit.Current, PasswordKit.Next, PasswordKit.Next + 'x')
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
        PasswordKit.Fill(dialog, PasswordKit.Next, PasswordKit.Next)
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
    })

    it('says inline why the new password or its confirmation is not acceptable, and nothing before typing', () =>
    {
        const { host, dialogs } = PasswordKit.Host()
        const dialog = new ChangePasswordDialogViewModel(host.Session, dialogs)
        const raised: string[] = []
        dialog.PropertyChanged('MismatchText').subscribe(e => { raised.push(String(e.newValue)) })
        assert.equal(dialog.NewPasswordText, '')
        assert.equal(dialog.MismatchText, '')
        dialog.NewPassword = 'short'
        assert.equal(dialog.NewPasswordText, 'Use at least 12 characters.')
        dialog.CurrentPassword = PasswordKit.Next
        dialog.NewPassword = PasswordKit.Next
        assert.equal(dialog.NewPasswordText, 'The new password must differ from the current one.')
        dialog.CurrentPassword = PasswordKit.Current
        assert.equal(dialog.NewPasswordText, '')
        dialog.ConfirmPassword = 'a-new-pass'
        assert.equal(dialog.MismatchText, 'The two new passwords do not match.')
        dialog.ConfirmPassword = PasswordKit.Next
        assert.equal(dialog.MismatchText, '')
        assert.deepEqual(raised, ['The two new passwords do not match.', ''])
    })

    it('a read-only (Observer) operator may change their own password', async () =>
    {
        const { api, host, dialogs } = PasswordKit.Host(OperatorContext.ReadOnlyWireRole)
        assert.equal(host.Session.CanMutate, false)
        const dialog = new ChangePasswordDialogViewModel(host.Session, dialogs)
        const opened = dialog.Open('Change your password')
        PasswordKit.Fill(dialog)
        assert.equal(dialog.ConfirmCommand.CanExecute(), true)
        dialog.ConfirmCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(await opened, { ok: true, otherSessionsEnded: true })
        assert.deepEqual(api.PasswordChanges, [[PasswordKit.Current, PasswordKit.Next, PasswordKit.Next]])
    })

    it('clears every password once it closes: changed, cancelled, or dismissed', async () =>
    {
        const { host, dialogs } = PasswordKit.Host()
        for (const close of ['confirm', 'cancel', 'dismiss'])
        {
            const dialog = new ChangePasswordDialogViewModel(host.Session, dialogs)
            const opened = dialog.Open('Change your password')
            PasswordKit.Fill(dialog)
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
            await Tick.Settle()
            await opened
            assert.deepEqual([dialog.CurrentPassword, dialog.NewPassword, dialog.ConfirmPassword], ['', '', ''], close)
        }
    })

    it('a wrong current password (403) keeps the dialog open with the reason; the session does not expire', async () =>
    {
        const { api, host, dialogs } = PasswordKit.Host()
        api.PasswordChangeFailure = new ApiError(403, 'The current password is not correct.')
        const dialog = new ChangePasswordDialogViewModel(host.Session, dialogs)
        void dialog.Open('Change your password')
        PasswordKit.Fill(dialog)
        dialog.ConfirmCommand.Execute()
        await Tick.Settle()
        assert.equal(dialog.ErrorText, 'The current password is not correct.')
        assert.equal(dialogs.IsOpen, true)
        assert.equal(host.Reloader.Count, 0)
        dialogs.Dismiss()
        await Tick.Settle()
        assert.equal(dialog.CurrentPassword, '')
    })

    it('the session Change password command opens the dialog and, once changed, says so in the header', async () =>
    {
        const { api, host, dialogs } = PasswordKit.Host(OperatorContext.ReadOnlyWireRole)
        assert.equal(host.Session.ChangePasswordCommand.CanExecute(), true)
        const done = host.Session.ChangePassword()
        await Tick.Next()
        const dialog = dialogs.Last as ChangePasswordDialogViewModel
        assert.ok(dialog instanceof ChangePasswordDialogViewModel)
        assert.equal(dialog.Email, PortalTestHost.Email)
        PasswordKit.Fill(dialog)
        dialog.ConfirmCommand.Execute()
        await done
        assert.equal(api.PasswordChanges.length, 1)
        assert.equal(host.Session.AccountNotice, 'Password changed. Your other sessions were signed out.')
    })

    it('a change the server only partly completed shows its warning in the header', async () =>
    {
        const { api, host, dialogs } = PasswordKit.Host()
        api.PasswordReply = { ok: true, otherSessionsEnded: true, warning: 'Your password is changed. Sign in again with the new password.' }
        const done = host.Session.ChangePassword()
        await Tick.Next()
        const dialog = dialogs.Last as ChangePasswordDialogViewModel
        PasswordKit.Fill(dialog)
        dialog.ConfirmCommand.Execute()
        await done
        assert.equal(host.Session.AccountNotice, 'Your password is changed. Sign in again with the new password.')
    })

    it('while the change is submitting a 401 elsewhere does not expire the session; once done the session is checked once and kept', async () =>
    {
        const { api, host, dialogs } = PasswordKit.Host()
        let release: () => void = () => undefined
        api.PasswordChangeHold = new Promise<void>(res => { release = res })
        const dialog = new ChangePasswordDialogViewModel(host.Session, dialogs)
        const opened = dialog.Open('Change your password')
        PasswordKit.Fill(dialog)
        dialog.ConfirmCommand.Execute()
        await Tick.Settle()
        // A page request answered 401 between the server's revoke and the fresh cookie.
        host.Session.Expire()
        assert.equal(host.Reloader.Count, 0)
        release()
        await opened
        await Tick.Settle()
        assert.equal(api.SessionChecks, 1)
        assert.equal(host.Reloader.Count, 0)
    })

    it('a 401 during the change whose session is really gone afterwards does expire, once the change is done', async () =>
    {
        const { api, host, dialogs } = PasswordKit.Host()
        let release: () => void = () => undefined
        api.PasswordChangeHold = new Promise<void>(res => { release = res })
        api.SessionAlive = false
        const dialog = new ChangePasswordDialogViewModel(host.Session, dialogs)
        const opened = dialog.Open('Change your password')
        PasswordKit.Fill(dialog)
        dialog.ConfirmCommand.Execute()
        await Tick.Settle()
        host.Session.Expire()
        assert.equal(host.Reloader.Count, 0)
        release()
        await opened
        await Tick.Settle()
        assert.equal(host.Reloader.Count, 1)
    })

    it('without a 401 during the change nothing is re-checked', async () =>
    {
        const { api, host, dialogs } = PasswordKit.Host()
        const dialog = new ChangePasswordDialogViewModel(host.Session, dialogs)
        const opened = dialog.Open('Change your password')
        PasswordKit.Fill(dialog)
        dialog.ConfirmCommand.Execute()
        await opened
        assert.equal(api.SessionChecks, 0)
        host.Session.Expire()
        assert.equal(host.Reloader.Count, 1, 'expiry works again once the change is done')
    })

    it('a cancelled change leaves the header notice empty', async () =>
    {
        const { host, dialogs } = PasswordKit.Host()
        const done = host.Session.ChangePassword()
        await Tick.Next()
        dialogs.Dismiss()
        await done
        assert.equal(host.Session.AccountNotice, '')
    })
})
