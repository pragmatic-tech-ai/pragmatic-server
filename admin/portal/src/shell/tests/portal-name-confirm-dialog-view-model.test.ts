import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PortalNameConfirmDialogViewModel } from '../portal-name-confirm-dialog-view-model.js'
import { PortalTestHost, Tick } from './portal-test-fixtures.js'

// The name-to-confirm dialog, with and without a required reason.
describe('PortalNameConfirmDialogViewModel', () =>
{
    it('without a reason label, the name alone enables Confirm', () =>
    {
        const host = PortalTestHost.WithoutClient()
        const dialog = new PortalNameConfirmDialogViewModel(host.Session, host.UseDialogs(), { Expected: 'acme', Message: 'Gone for good.', Action: async () => { } })
        assert.equal(dialog.RequiresReason, false)
        dialog.Typed = 'acme'
        assert.equal(dialog.ConfirmCommand.CanExecute(), true)
    })

    it('surrounding spaces do not count, but the name must otherwise match exactly', () =>
    {
        const host = PortalTestHost.WithoutClient()
        const dialog = new PortalNameConfirmDialogViewModel(host.Session, host.UseDialogs(), { Expected: 'acme', Message: 'Gone for good.', Action: async () => { } })
        dialog.Typed = '  acme '
        assert.equal(dialog.IsMatch, true)
        assert.equal(dialog.ConfirmCommand.CanExecute(), true)
        dialog.Typed = 'Acme'
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
    })

    it('says when the typed text does not match yet; nothing before typing, nothing once it matches', () =>
    {
        const host = PortalTestHost.WithoutClient()
        const dialog = new PortalNameConfirmDialogViewModel(host.Session, host.UseDialogs(), { Expected: 'acme', Message: 'Gone for good.', Action: async () => { } })
        const raised: string[] = []
        dialog.PropertyChanged('MismatchText').subscribe(e => { raised.push(String(e.newValue)) })
        assert.equal(dialog.MismatchText, '')
        dialog.Typed = 'acm'
        assert.equal(dialog.MismatchText, 'That does not match acme yet.')
        assert.deepEqual(raised, ['That does not match acme yet.'])
        dialog.Typed = 'acme'
        assert.equal(dialog.MismatchText, '')
    })

    it('with a reason label, Confirm needs the name and a non-blank reason, which the action receives trimmed', async () =>
    {
        const host = PortalTestHost.WithoutClient()
        const dialogs = host.UseDialogs()
        const received: string[] = []
        const dialog = new PortalNameConfirmDialogViewModel(host.Session, dialogs,
            { Expected: '1.4.0', Message: 'Withdraw it.', Action: async (reason) => { received.push(reason) }, ConfirmLabel: 'Withdraw', ReasonLabel: 'Reason' })
        assert.equal(dialog.RequiresReason, true)
        assert.equal(dialog.ReasonLabel, 'Reason')
        const opened = dialog.Open('Withdraw 1.4.0?')
        dialog.Typed = '1.4.0'
        dialog.Reason = '   '
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
        dialog.Reason = ' Broken export '
        assert.equal(dialog.ConfirmCommand.CanExecute(), true)
        dialog.ConfirmCommand.Execute()
        await Tick.Settle()
        assert.equal(await opened, PortalNameConfirmDialogViewModel.Confirmed)
        assert.deepEqual(received, ['Broken export'])
    })
})
