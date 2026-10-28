import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { App } from '../src/app.js'
import { Banner } from '../src/kit/index.js'
import { ClientListView } from '../src/client-list-view.js'
import { ComingSoonView } from '../src/coming-soon-view.js'
import { LoginView } from '../src/login-view.js'
import { PaSection } from '../src/nav-model.js'
import { NavRail } from '../src/nav-rail.js'
import { TopBar } from '../src/top-bar.js'
import type { ControlPlaneClient } from '../src/api-client.js'

interface SessionFixture
{
    email: string
    principalId: string
    role: string
}

class FakeClient
{
    public constructor(private readonly operator: SessionFixture | null)
    {
    }

    public Session(): Promise<SessionFixture | null>
    {
        return Promise.resolve(this.operator)
    }

    public Logout(): Promise<void>
    {
        return Promise.resolve()
    }

    public OnChanged(_handler: () => void): void
    {
    }

    public ListClients(): Promise<unknown[]>
    {
        return Promise.resolve([])
    }
}

class Fixtures
{
    public static Make(operator: SessionFixture | null): App
    {
        return new App(new FakeClient(operator) as unknown as ControlPlaneClient, false)
    }
}

describe('PA shell app', () =>
{
    let previous: Application | null

    before(() =>
    {
        previous = Application.current
        const app = new Application()
        Application.current = app
        app.initialize({ theme: Pragmatic, scheme: PragmaticLight })
    })

    after(() =>
    {
        Application.current = previous
    })

    it('mounts login and no nav when signed out', async () =>
    {
        const app = Fixtures.Make(null)
        await app.Boot()
        assert.ok(app.CurrentView instanceof LoginView)
        assert.equal(app.Nav, undefined)
        assert.equal(app.Top, undefined)
    })

    it('mounts nav, top bar and Fleet when signed in', async () =>
    {
        const app = Fixtures.Make({ email: 'op@example.com', principalId: 'p1', role: 'full' })
        await app.Boot()
        assert.ok(app.Nav instanceof NavRail)
        assert.ok(app.Top instanceof TopBar)
        assert.ok(app.CurrentView instanceof ComingSoonView)
        assert.equal(app.ActiveSection, PaSection.Fleet)
        assert.equal(app.Nav.Active, PaSection.Fleet)
        // The legacy entry lives in the top bar, never in the primary nav: exactly the nine designed rows.
        assert.equal(app.Nav.Rows.size, 9)
    })

    it('routes every section to a placeholder', async () =>
    {
        const app = Fixtures.Make({ email: 'op@example.com', principalId: 'p1', role: 'full' })
        await app.Boot()
        for (const section of Object.values(PaSection))
        {
            app.ShowSection(section)
            assert.ok(app.CurrentView instanceof ComingSoonView)
            assert.equal(app.ActiveSection, section)
            assert.equal(app.Nav?.Active, section)
        }
    })

    it('legacy navigation mounts the legacy view without changing the active section', async () =>
    {
        const app = Fixtures.Make({ email: 'op@example.com', principalId: 'p1', role: 'full' })
        await app.Boot()
        app.ShowSection(PaSection.Hives)
        app.ShowClients()
        assert.ok(app.CurrentView instanceof ClientListView)
        assert.equal(app.ActiveSection, PaSection.Hives)
        assert.equal(app.Nav?.Active, PaSection.Hives)
    })

    it('shows the Operator role and no banner for a full session', async () =>
    {
        const app = Fixtures.Make({ email: 'op@example.com', principalId: 'p1', role: 'full' })
        await app.Boot()
        assert.equal(app.Operator?.CanMutate, true)
        assert.equal(app.Top?.RoleLabelText, 'Operator')
        assert.equal([...(app.Top?.BannerSlot.Children ?? [])].filter(c => c instanceof Banner).length, 0)
    })

    it('shows the Observer role and one read-only banner for a readonly session', async () =>
    {
        const app = Fixtures.Make({ email: 'ob@example.com', principalId: 'p2', role: 'readonly' })
        await app.Boot()
        assert.equal(app.Operator?.CanMutate, false)
        assert.equal(app.Top?.RoleLabelText, 'Observer')
        assert.equal([...(app.Top?.BannerSlot.Children ?? [])].filter(c => c instanceof Banner).length, 1)
    })

    it('clears the operator on logout', async () =>
    {
        const app = Fixtures.Make({ email: 'ob@example.com', principalId: 'p2', role: 'readonly' })
        await app.Boot()
        app.ShowLogin()
        assert.equal(app.Operator, undefined)
    })
})
