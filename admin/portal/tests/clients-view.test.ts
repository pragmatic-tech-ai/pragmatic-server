import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import type { ControlPlaneClient } from '../src/api-client.js'
import { ClientsMode, ClientsView } from '../src/clients-view.js'
import { OperatorContext } from '../src/operator-context.js'
import { ScreenState } from '../src/kit/index.js'
import type { ClientDto, FleetHiveDto, TenantDto } from '../src/portal-types.js'

class FakeClient
{
    public readonly Created: string[] = []

    public constructor(private readonly clients: ClientDto[], private readonly fail = false, private readonly failCreate = false)
    {
    }

    public ListClients(): Promise<ClientDto[]>
    {
        return this.fail ? Promise.reject(new Error('boom')) : Promise.resolve(this.clients)
    }

    public ListTenants(clientId?: string): Promise<TenantDto[]>
    {
        const all: TenantDto[] = this.clients.map(c => ({ id: 't-' + c.id, clientId: c.id, displayName: 'T ' + c.id }))
        return Promise.resolve(clientId === undefined ? all : all.filter(t => t.clientId === clientId))
    }

    public ListFleet(): Promise<FleetHiveDto[]>
    {
        return Promise.resolve([])
    }

    public CreateClient(id: string, displayName: string): Promise<ClientDto>
    {
        if (this.failCreate)
        {
            return Promise.reject(new Error('taken'))
        }
        this.Created.push(id)
        return Promise.resolve({ id, displayName, createdAt: '2026-01-01T00:00:00Z' })
    }
}

class Fixtures
{
    public static Client(id: string): ClientDto
    {
        return { id, displayName: 'Client ' + id, createdAt: '2026-01-02T00:00:00Z' }
    }

    public static CreateView(failCreate: boolean): ClientsView
    {
        return new ClientsView(
            new FakeClient([Fixtures.Client('a')], false, failCreate) as unknown as ControlPlaneClient,
            OperatorContext.FromWire('full'),
        )
    }

    public static View(clients: ClientDto[], role = 'full', fail = false): ClientsView
    {
        return new ClientsView(new FakeClient(clients, fail) as unknown as ControlPlaneClient, OperatorContext.FromWire(role as 'full'))
    }
}

describe('ClientsView', () =>
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

    it('lists clients populated', async () =>
    {
        const view = Fixtures.View([Fixtures.Client('a'), Fixtures.Client('b')])
        await view.Refresh()
        assert.equal(view.Mode, ClientsMode.List)
        assert.equal(view.Host.State, ScreenState.Populated)
        assert.equal(view.Table?.Rows.length, 2)
    })

    it('is empty with no clients', async () =>
    {
        const view = Fixtures.View([])
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Empty)
    })

    it('shows error on a rejected fetch', async () =>
    {
        const view = Fixtures.View([], 'full', true)
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Error)
    })

    it('gates create by operator role', async () =>
    {
        const observer = Fixtures.View([Fixtures.Client('a')], 'readonly')
        await observer.Refresh()
        assert.equal(observer.CreateAction?.Enabled, false)
        assert.ok(observer.CreateAction?.DisabledHint?.includes('Operator'))
        const operator = Fixtures.View([Fixtures.Client('a')], 'full')
        await operator.Refresh()
        assert.equal(operator.CreateAction?.Enabled, true)
    })

    it('opens a client into detail', async () =>
    {
        const view = Fixtures.View([Fixtures.Client('a')])
        await view.Refresh()
        view.Table?.FocusRow(0)
        view.Table?.ActivateFocused()
        await new Promise(r => setTimeout(r, 20))
        assert.equal(view.Mode, ClientsMode.Detail)
    })

    it('survives a second refresh', async () =>
    {
        const view = Fixtures.View([Fixtures.Client('a'), Fixtures.Client('b')])
        await view.Refresh()
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Populated)
    })

    it('returns to the list after a successful create', async () =>
    {
        const view = Fixtures.CreateView(false)
        await view.ShowList()
        view.ShowCreate()
        view.SubmitAction?.Press()
        await new Promise(r => setTimeout(r, 0))
        assert.equal(view.Mode, ClientsMode.List)
    })

    it('stays on the form when create fails', async () =>
    {
        const view = Fixtures.CreateView(true)
        await view.ShowList()
        view.ShowCreate()
        view.SubmitAction?.Press()
        await new Promise(r => setTimeout(r, 0))
        assert.equal(view.Mode, ClientsMode.Create)
    })
})
