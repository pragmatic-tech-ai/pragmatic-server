import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import type { ControlPlaneClient } from '../src/api-client.js'
import { ClientsMode, ClientsView } from '../src/clients-view.js'
import { ProvisionWizardView } from '../src/provision-wizard-view.js'
import { OperatorContext } from '../src/operator-context.js'
import { ErrorStatePanel, ScreenState } from '../src/kit/index.js'
import type { ClientDto, FleetHiveDto, TenantDto } from '../src/portal-types.js'

class FakeClient
{
    public readonly Created: string[] = []
    public DetailBroken = false

    public constructor(private readonly clients: ClientDto[], private readonly fail = false, private readonly failCreate = false, private readonly failDetail = false)
    {
    }

    public ListClients(): Promise<ClientDto[]>
    {
        return this.fail ? Promise.reject(new Error('boom')) : Promise.resolve(this.clients)
    }

    public ListTenants(clientId?: string): Promise<TenantDto[]>
    {
        if ((this.failDetail || this.DetailBroken) && clientId !== undefined)
        {
            return Promise.reject(new Error('detail boom'))
        }
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

    public static Retry(view: ClientsView): void
    {
        const panel = Fixtures.Walk(view).find(n => n instanceof ErrorStatePanel) as ErrorStatePanel
        assert.ok(panel)
        panel.RetryButton.Press()
    }

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

    it('falls back to the list error state when the detail fetch fails', async () =>
    {
        const view = new ClientsView(
            new FakeClient([Fixtures.Client('a')], false, false, true) as unknown as ControlPlaneClient,
            OperatorContext.FromWire('full'),
        )
        await view.ShowList()
        view.Table?.FocusRow(0)
        view.Table?.ActivateFocused()
        await new Promise(r => setTimeout(r, 0))
        assert.equal(view.Mode, ClientsMode.List)
        assert.equal(view.Host.State, ScreenState.Error)
    })

    it('survives a second refresh in detail mode', async () =>
    {
        const view = Fixtures.View([Fixtures.Client('a')])
        await view.ShowList()
        view.Table?.FocusRow(0)
        view.Table?.ActivateFocused()
        await new Promise(r => setTimeout(r, 0))
        assert.equal(view.Mode, ClientsMode.Detail)
        await view.Refresh()
        assert.equal(view.Mode, ClientsMode.Detail)
    })

    it('detail-fetch failure shows a live retry that recovers to the list', async () =>
    {
        const fake = new FakeClient([Fixtures.Client('a')])
        const view = new ClientsView(fake as unknown as ControlPlaneClient, OperatorContext.FromWire('full'))
        await view.ShowList()
        fake.DetailBroken = true
        view.Table?.FocusRow(0)
        view.Table?.ActivateFocused()
        await new Promise(r => setTimeout(r, 0))
        assert.equal(view.Host.State, ScreenState.Error)
        fake.DetailBroken = false
        Fixtures.Retry(view)
        await new Promise(r => setTimeout(r, 0))
        assert.equal(view.Mode, ClientsMode.List)
        assert.equal(view.Host.State, ScreenState.Populated)
        assert.equal(view.Table?.Rows.length, 1)
    })

    it('offers Provision customer to a full operator', async () =>
    {
        const view = Fixtures.View([Fixtures.Client('a')], 'full')
        await view.Refresh()
        assert.ok(view.ProvisionAction)
        assert.equal(view.ProvisionAction.Enabled, true)
    })

    it('shows Provision customer disabled for an observer and ignores a press', async () =>
    {
        const view = Fixtures.View([Fixtures.Client('a')], 'readonly')
        await view.Refresh()
        assert.ok(view.ProvisionAction)
        assert.equal(view.ProvisionAction.Enabled, false)
        view.ProvisionAction.Press()
        assert.equal(view.WizardScreen, undefined)
        assert.equal(view.Mode, ClientsMode.List)
    })

    it('opens the provisioning wizard when a full operator activates Provision customer', async () =>
    {
        const view = Fixtures.View([Fixtures.Client('a')], 'full')
        await view.Refresh()
        view.ProvisionAction?.Press()
        assert.ok(view.WizardScreen instanceof ProvisionWizardView)
        assert.equal(view.Mode, ClientsMode.Create)
        assert.ok(Fixtures.Walk(view).includes(view.WizardScreen))
    })

    it('returns to the list when the wizard completes', async () =>
    {
        const view = Fixtures.View([Fixtures.Client('a')], 'full')
        await view.Refresh()
        view.ProvisionAction?.Press()
        view.ReturnFromWizard()
        await new Promise(r => setTimeout(r, 0))
        assert.equal(view.Mode, ClientsMode.List)
    })
})
