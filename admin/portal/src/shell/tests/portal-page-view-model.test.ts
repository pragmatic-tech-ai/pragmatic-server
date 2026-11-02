import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError, type ControlPlaneClient } from '../../api-client.js'
import { PageState, PortalPageViewModel } from '../portal-page-view-model.js'
import type { PortalSessionService } from '../portal-session-service.js'
import { PortalTestHost } from './portal-test-fixtures.js'

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

    protected override LoadCore(): Promise<boolean>
    {
        return this.load()
    }
}

class Fx
{
    public static Host(): PortalTestHost
    {
        return new PortalTestHost({} as ControlPlaneClient)
    }
}

describe('PortalPageViewModel', () =>
{
    it('starts Loading', () =>
    {
        const page = new ScriptedPage(Fx.Host().Session, async () => true)
        assert.equal(page.State, PageState.Loading)
        assert.equal(page.IsLoading, true)
    })

    it('content -> Populated', async () =>
    {
        const page = new ScriptedPage(Fx.Host().Session, async () => true)
        await page.Refresh()
        assert.equal(page.State, PageState.Populated)
        assert.equal(page.IsPopulated, true)
        assert.equal(page.IsLoading, false)
    })

    it('no content -> Empty', async () =>
    {
        const page = new ScriptedPage(Fx.Host().Session, async () => false)
        await page.Refresh()
        assert.equal(page.State, PageState.Empty)
        assert.equal(page.IsEmpty, true)
    })

    it('a 401 expires the session once', async () =>
    {
        const host = Fx.Host()
        const page = new ScriptedPage(host.Session, async () => { throw new ApiError(401, 'unauthorized') })
        await page.Refresh()
        assert.equal(host.Reloader.Count, 1)
        host.Session.Expire()
        assert.equal(host.Reloader.Count, 1)
    })

    it('a non-401 failure -> Error with the message', async () =>
    {
        const host = Fx.Host()
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
        const page = new ScriptedPage(Fx.Host().Session, async () =>
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

    it('Guard applies the same 401 and error handling to commands', async () =>
    {
        const host = Fx.Host()
        const page = new ScriptedPage(host.Session, async () => true)
        await page.RunGuarded(async () => { throw new Error('nope') })
        assert.equal(page.State, PageState.Error)
        assert.equal(page.ErrorText, 'nope')
        await page.RunGuarded(async () => { throw new ApiError(401, 'gone') })
        assert.equal(host.Reloader.Count, 1)
    })
})
