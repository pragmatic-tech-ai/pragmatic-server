import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../../api-client.js'
import { PageState, PortalPageViewModel } from '../portal-page-view-model.js'
import type { PortalSessionService } from '../portal-session-service.js'
import type { RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { PortalTestHost, Tick } from './portal-test-fixtures.js'

class ScriptedPage extends PortalPageViewModel
{
    public constructor(session: PortalSessionService, private readonly load: () => Promise<boolean>)
    {
        super(session)
    }

    public RunGuarded(action: () => Promise<void>): Promise<void>
    {
        return this.Guard(action)
    }

    public Mutating(run: () => Promise<void>, enabled?: () => boolean): RelayCommand
    {
        return this.MutatingCommand(run, enabled)
    }

    protected override LoadCore(): Promise<boolean>
    {
        return this.load()
    }
}

// A load whose outcome the test settles by hand.
class PendingLoad
{
    public Resolve: (hasContent: boolean) => void = () => { }
    public Reject: (e: unknown) => void = () => { }
    public readonly Promise: Promise<boolean>

    public constructor()
    {
        this.Promise = new Promise<boolean>((resolve, reject) =>
        {
            this.Resolve = resolve
            this.Reject = reject
        })
    }
}

describe('PortalPageViewModel', () =>
{
    it('starts Loading', () =>
    {
        const page = new ScriptedPage(PortalTestHost.WithoutClient().Session, async () => true)
        assert.equal(page.State, PageState.Loading)
        assert.equal(page.IsLoading, true)
    })

    it('content -> Populated', async () =>
    {
        const page = new ScriptedPage(PortalTestHost.WithoutClient().Session, async () => true)
        await page.Refresh()
        assert.equal(page.State, PageState.Populated)
        assert.equal(page.IsPopulated, true)
        assert.equal(page.IsLoading, false)
    })

    it('no content -> Empty', async () =>
    {
        const page = new ScriptedPage(PortalTestHost.WithoutClient().Session, async () => false)
        await page.Refresh()
        assert.equal(page.State, PageState.Empty)
        assert.equal(page.IsEmpty, true)
    })

    it('a 401 expires the session once', async () =>
    {
        const host = PortalTestHost.WithoutClient()
        const page = new ScriptedPage(host.Session, async () => { throw new ApiError(401, 'unauthorized') })
        await page.Refresh()
        assert.equal(host.Reloader.Count, 1)
        host.Session.Expire()
        assert.equal(host.Reloader.Count, 1)
    })

    it('a non-401 failure -> Error with the message', async () =>
    {
        const host = PortalTestHost.WithoutClient()
        const page = new ScriptedPage(host.Session, async () => { throw new ApiError(500, 'boom') })
        await page.Refresh()
        assert.equal(page.State, PageState.Error)
        assert.equal(page.IsError, true)
        assert.equal(page.ErrorText, 'boom')
        assert.equal(host.Reloader.Count, 0)
    })

    it('a successful reload clears a previous error', async () =>
    {
        let fail = true
        const page = new ScriptedPage(PortalTestHost.WithoutClient().Session, async () =>
        {
            if (fail)
            {
                throw new Error('down')
            }
            return true
        })
        await page.Refresh()
        fail = false
        await page.Refresh()
        assert.equal(page.State, PageState.Populated)
        assert.equal(page.ErrorText, '')
    })

    it('an older refresh settling last is discarded', async () =>
    {
        const loads = [new PendingLoad(), new PendingLoad()]
        let next = 0
        const page = new ScriptedPage(PortalTestHost.WithoutClient().Session, () => loads[next++].Promise)
        const first = page.Refresh()
        const second = page.Refresh()
        loads[1].Resolve(false)
        await second
        loads[0].Resolve(true)
        await first
        assert.equal(page.State, PageState.Empty)
    })

    it('an older refresh failing last is discarded', async () =>
    {
        const loads = [new PendingLoad(), new PendingLoad()]
        let next = 0
        const page = new ScriptedPage(PortalTestHost.WithoutClient().Session, () => loads[next++].Promise)
        const first = page.Refresh()
        const second = page.Refresh()
        loads[1].Resolve(true)
        await second
        loads[0].Reject(new Error('stale'))
        await first
        assert.equal(page.State, PageState.Populated)
        assert.equal(page.ErrorText, '')
    })

    it('a failed command keeps State and sets CommandErrorText', async () =>
    {
        const host = PortalTestHost.WithoutClient()
        const page = new ScriptedPage(host.Session, async () => true)
        await page.Refresh()
        await page.RunGuarded(async () => { throw new Error('nope') })
        assert.equal(page.State, PageState.Populated)
        assert.equal(page.ErrorText, '')
        assert.equal(page.CommandErrorText, 'nope')
        assert.equal(host.Reloader.Count, 0)
    })

    it('the next command clears CommandErrorText', async () =>
    {
        const page = new ScriptedPage(PortalTestHost.WithoutClient().Session, async () => true)
        await page.RunGuarded(async () => { throw new Error('nope') })
        await page.RunGuarded(async () => { })
        assert.equal(page.CommandErrorText, '')
    })

    it('a 401 from a command expires the session', async () =>
    {
        const host = PortalTestHost.WithoutClient()
        const page = new ScriptedPage(host.Session, async () => true)
        await page.RunGuarded(async () => { throw new ApiError(401, 'gone') })
        assert.equal(host.Reloader.Count, 1)
        assert.equal(page.CommandErrorText, '')
    })

    it('a reload of a Populated page stays Populated while it runs', async () =>
    {
        const loads = [new PendingLoad(), new PendingLoad()]
        let next = 0
        const page = new ScriptedPage(PortalTestHost.WithoutClient().Session, () => loads[next++].Promise)
        const first = page.Refresh()
        loads[0].Resolve(true)
        await first
        const states: PageState[] = []
        page.PropertyChanged('State').subscribe(e => states.push(e.newValue as PageState))
        const second = page.Refresh()
        assert.equal(page.State, PageState.Populated)
        assert.equal(page.IsLoading, false)
        loads[1].Resolve(true)
        await second
        assert.equal(page.State, PageState.Populated)
        assert.deepEqual(states, [])
    })

    it('a reload of a Populated page still switches to Empty or Error', async () =>
    {
        const outcomes: Array<() => Promise<boolean>> = [async () => true, async () => false, async () => true, async () => { throw new Error('down') }]
        let next = 0
        const page = new ScriptedPage(PortalTestHost.WithoutClient().Session, () => outcomes[next++]())
        await page.Refresh()
        await page.Refresh()
        assert.equal(page.State, PageState.Empty)
        await page.Refresh()
        assert.equal(page.State, PageState.Populated)
        await page.Refresh()
        assert.equal(page.State, PageState.Error)
        assert.equal(page.ErrorText, 'down')
    })

    it('a running mutating command disables every mutating command of the page until it settles', async () =>
    {
        const page = new ScriptedPage(PortalTestHost.WithoutClient().Session, async () => true)
        const held = new PendingLoad()
        let firstRuns = 0
        let secondRuns = 0
        const first = page.Mutating(async () => { firstRuns++; await held.Promise })
        const second = page.Mutating(async () => { secondRuns++ })
        let raised = 0
        second.AddCanExecuteChangedListener(() => raised++)
        first.Execute()
        assert.equal(first.CanExecute(), false)
        assert.equal(second.CanExecute(), false)
        assert.equal(raised, 1)
        first.Execute()
        second.Execute()
        await Tick.Settle()
        assert.equal(firstRuns, 1)
        assert.equal(secondRuns, 0)
        held.Resolve(true)
        await Tick.Settle()
        assert.equal(first.CanExecute(), true)
        assert.equal(second.CanExecute(), true)
        assert.equal(raised, 2)
        second.Execute()
        await Tick.Settle()
        assert.equal(secondRuns, 1)
    })

    it('a failed mutating command re-enables the page commands', async () =>
    {
        const page = new ScriptedPage(PortalTestHost.WithoutClient().Session, async () => true)
        const command = page.Mutating(async () => { throw new Error('refused') })
        command.Execute()
        await Tick.Settle()
        assert.equal(page.CommandErrorText, 'refused')
        assert.equal(command.CanExecute(), true)
    })
})
