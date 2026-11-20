import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { DialogService } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import { ShellDialogViewModel } from '@pragmatic-tech-ai/pragmatic-app-shell'
import { OperatorContext } from '../../operator-context.js'
import type { ControlPlaneClient } from '../../api-client.js'
import type { PortalSessionService } from '../portal-session-service.js'
import { PortalDialogViewModel } from '../portal-dialog-view-model.js'
import { PortalTestHost } from './portal-test-fixtures.js'

// A complete dialog; `mutates` says whether it needs the Operator role.
class ReadyDialog extends PortalDialogViewModel<string>
{
    public constructor(session: PortalSessionService, dialogs: DialogService, private readonly mutates: boolean)
    {
        super(session, dialogs)
    }

    protected override get RequiresMutate(): boolean
    {
        return this.mutates
    }

    protected override get CanConfirm(): boolean
    {
        return true
    }

    protected override async SubmitCore(): Promise<string>
    {
        return 'done'
    }
}

// The console's dialogs are the shell's dialog (open / submit / dismiss, tested in pragmatic-app-shell) with the
// console's permission rule.
describe('PortalDialogViewModel', () =>
{
    it('is the shell dialog', () =>
    {
        const host = new PortalTestHost({} as ControlPlaneClient)
        assert.ok(new ReadyDialog(host.Session, host.UseDialogs(), true) instanceof ShellDialogViewModel)
    })

    it('a mutating dialog confirms for an Operator only', () =>
    {
        const operator = new PortalTestHost({} as ControlPlaneClient)
        const observer = new PortalTestHost({} as ControlPlaneClient, OperatorContext.ReadOnlyWireRole)
        assert.equal(new ReadyDialog(operator.Session, operator.UseDialogs(), true).ConfirmCommand.CanExecute(), true)
        assert.equal(new ReadyDialog(observer.Session, observer.UseDialogs(), true).ConfirmCommand.CanExecute(), false)
    })

    it('a dialog that does not mutate confirms for an Observer too', () =>
    {
        const observer = new PortalTestHost({} as ControlPlaneClient, OperatorContext.ReadOnlyWireRole)
        assert.equal(new ReadyDialog(observer.Session, observer.UseDialogs(), false).ConfirmCommand.CanExecute(), true)
    })
})
