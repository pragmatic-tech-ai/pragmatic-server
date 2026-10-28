import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import type { ControlPlaneClient } from '../src/api-client.js'
import { TenantsMode, TenantsView } from '../src/tenants-view.js'
import { TenantDetailView } from '../src/tenant-detail-view.js'
import { ScreenState } from '../src/kit/index.js'
import type { ClientDto, FleetHiveDto, TenantDto } from '../src/portal-types.js'

class FakeClient
{
    public constructor(
        private readonly tenants: TenantDto[],
        private readonly fail = false,
        private readonly failDetail = false,
    )
    {
    }

    public ListTenants(): Promise<TenantDto[]>
    {
        return this.fail ? Promise.reject(new Error('boom')) : Promise.resolve(this.tenants)
    }

    public ListClients(): Promise<ClientDto[]>
    {
        if (this.failDetail && this.calls++ > 0)
        {
            return Promise.reject(new Error('detail boom'))
        }
        return Promise.resolve([{ id: 'c1', displayName: 'Client 1', createdAt: '2026-01-01T00:00:00Z' }])
    }

    public ListFleet(): Promise<FleetHiveDto[]>
    {
        return Promise.resolve([])
    }

    private calls = 0
}

class Fixtures
{
    public static Walk(root: unknown): unknown[]
    {
        const out: unknown[] = [root]
        const children = (root as { Children?: Iterable<unknown> }).Children
        for (const c of children ?? [])
        {
            out.push(...Fixtures.Walk(c))
        }
        return out
    }

    public static Tenant(id: string): TenantDto
    {
        return { id, clientId: 'c1', displayName: 'Tenant ' + id, createdAt: '2026-01-02T00:00:00Z' }
    }

    public static View(tenants: TenantDto[], fail = false, failDetail = false): TenantsView
    {
        return new TenantsView(new FakeClient(tenants, fail, failDetail) as unknown as ControlPlaneClient)
    }
}

describe('TenantsView', () =>
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

    it('lists tenants populated', async () =>
    {
        const view = Fixtures.View([Fixtures.Tenant('a'), Fixtures.Tenant('b')])
        await view.Refresh()
        assert.equal(view.Mode, TenantsMode.List)
        assert.equal(view.Host.State, ScreenState.Populated)
        assert.equal(view.Table?.Rows.length, 2)
    })

    it('is empty with no tenants', async () =>
    {
        const view = Fixtures.View([])
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Empty)
    })

    it('shows error on a rejected fetch', async () =>
    {
        const view = Fixtures.View([], true)
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Error)
    })

    it('opens a tenant into detail', async () =>
    {
        const view = Fixtures.View([Fixtures.Tenant('a')])
        await view.Refresh()
        view.Table?.FocusRow(0)
        view.Table?.ActivateFocused()
        await new Promise(r => setTimeout(r, 0))
        assert.equal(view.Mode, TenantsMode.Detail)
        assert.ok(Fixtures.Walk(view).some(n => n instanceof TenantDetailView))
        await view.Refresh()
        assert.equal(view.Mode, TenantsMode.Detail)
    })

    it('falls back to the list error state when the detail fetch fails', async () =>
    {
        const view = Fixtures.View([Fixtures.Tenant('a')], false, true)
        await view.Refresh()
        view.Table?.FocusRow(0)
        view.Table?.ActivateFocused()
        await new Promise(r => setTimeout(r, 0))
        assert.equal(view.Mode, TenantsMode.List)
        assert.equal(view.Host.State, ScreenState.Error)
    })

    it('survives a second refresh', async () =>
    {
        const view = Fixtures.View([Fixtures.Tenant('a'), Fixtures.Tenant('b')])
        await view.Refresh()
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Populated)
    })
})
