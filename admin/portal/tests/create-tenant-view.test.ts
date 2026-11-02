import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { CreateTenantView } from '../src/create-tenant-view.js'
import type { ClientDto, CreatedTenantDto, IPortalNavigator } from '../src/portal-types.js'

class FakeSource
{
    public Calls: unknown[][] = []

    public async ListClients(): Promise<ClientDto[]>
    {
        return [{ id: 'c1', displayName: 'Client One', createdAt: '2026-01-01T00:00:00.000Z' }]
    }

    public async CreateTenant(id: string, clientId: string, displayName: string, ownerEmail: string): Promise<CreatedTenantDto>
    {
        this.Calls.push([id, clientId, displayName, ownerEmail])
        return { id, clientId, displayName, owner: { email: ownerEmail, principalId: 'owner', password: Fixtures.Password } }
    }
}

class FakeNav
{
    public Tenants: string[] = []

    public ShowTenants(clientId: string): void
    {
        this.Tenants.push(clientId)
    }
}

class Fixtures
{
    public static readonly Password = 'pw-one-time'

    public static async Ready(source: FakeSource, nav: FakeNav): Promise<CreateTenantView>
    {
        const view = new CreateTenantView(source, nav as unknown as IPortalNavigator, 'c1')
        await view.Refresh()
        view.IdBox.Text = 't1'
        view.NameBox.Text = 'Tenant One'
        view.OwnerBox.Text = 'owner@acme.test'
        return view
    }
}

describe('CreateTenantView', () =>
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

    it('submits the owner email and reveals the one-time owner password before leaving', async () =>
    {
        const source = new FakeSource()
        const nav = new FakeNav()
        const view = await Fixtures.Ready(source, nav)
        const before = view.Reveal
        assert.equal(before, undefined)
        await view.Submit()
        assert.deepEqual(source.Calls, [['t1', 'c1', 'Tenant One', 'owner@acme.test']])
        assert.equal(view.Reveal?.Value, Fixtures.Password)
        assert.deepEqual(nav.Tenants, [])
        view.Reveal?.ConfirmButton.Press()
        assert.deepEqual(nav.Tenants, ['c1'])
    })
})
