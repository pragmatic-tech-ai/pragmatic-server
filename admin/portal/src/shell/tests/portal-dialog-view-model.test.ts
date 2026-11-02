import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DialogService, type DialogOptions } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import type { PortalSessionService } from '../portal-session-service.js'
import { PortalDialogViewModel } from '../portal-dialog-view-model.js'
import { PortalTestHost, Tick } from './portal-test-fixtures.js'

// A dialog whose submit waits until Release.
class HeldDialog extends PortalDialogViewModel<string>
{
    private release: (() => void) | undefined

    public constructor(session: PortalSessionService, dialogs: DialogService)
    {
        super(session, dialogs)
    }

    public Release(): void
    {
        this.release?.()
    }

    protected override get CanConfirm(): boolean
    {
        return true
    }

    protected override async SubmitCore(): Promise<string>
    {
        await new Promise<void>(resolve => { this.release = resolve })
        return 'done'
    }
}

// A service whose superseded dialog settles late: a newer Show takes over at
// once, but the older Show's promise resolves only on a later tick.
class LateSettlingDialogs extends DialogService
{
    public readonly Closes: unknown[] = []
    private settle: ((value: unknown) => void) | undefined
    private superseded: ((value: unknown) => void) | undefined

    public override Show<T = unknown>(_options: DialogOptions): Promise<T | undefined>
    {
        this.superseded = this.settle
        return new Promise<T | undefined>(resolve => { this.settle = resolve as (value: unknown) => void })
    }

    // Settles the superseded dialog's Show, on the test's cue.
    public SettleSuperseded(): void
    {
        this.superseded?.(undefined)
        this.superseded = undefined
    }

    public override Close(result?: unknown): void
    {
        this.Closes.push(result)
        const settle = this.settle
        this.settle = undefined
        settle?.(result)
    }
}

describe('PortalDialogViewModel', () =>
{
    it('a submit settling while a superseding dialog is open does not close it, even before the old Show settles', async () =>
    {
        const host = PortalTestHost.WithoutClient()
        const dialogs = new LateSettlingDialogs(host.Provider)
        const first = new HeldDialog(host.Session, dialogs)
        const firstOpened = first.Open('First')
        first.ConfirmCommand.Execute()
        await Tick.Next()
        const second = new HeldDialog(host.Session, dialogs)
        const secondOpened = second.Open('Second')
        first.Release()
        await Tick.Settle()
        // The first submit has settled while its own Show is still unsettled.
        assert.deepEqual(dialogs.Closes, [])
        dialogs.SettleSuperseded()
        assert.equal(await firstOpened, 'done')
        assert.deepEqual(dialogs.Closes, [])
        dialogs.Close(undefined)
        assert.equal(await secondOpened, undefined)
    })

    it('a submit settling while its own dialog is open closes it with the result', async () =>
    {
        const host = PortalTestHost.WithoutClient()
        const dialogs = new LateSettlingDialogs(host.Provider)
        const dialog = new HeldDialog(host.Session, dialogs)
        const opened = dialog.Open('Only')
        dialog.ConfirmCommand.Execute()
        await Tick.Next()
        dialog.Release()
        assert.equal(await opened, 'done')
        assert.deepEqual(dialogs.Closes, ['done'])
    })
})
