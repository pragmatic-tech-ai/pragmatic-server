import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Application, Key } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { ClientDetailView } from '../src/client-detail-view.js'
import { ClientDetailViewModel } from '../src/client-detail-view-model.js'
import { KeyActivatedButton, ScreenState } from '../src/kit/index.js'
import type { ClientDto, FleetHiveDto, TenantDto } from '../src/portal-types.js'

class Fixtures
{
    public static readonly Client: ClientDto = { id: 'c1', displayName: 'Acme', createdAt: '2026-01-02T00:00:00.000Z' }

    public static Tenant(id: string): TenantDto
    {
        return { id, clientId: 'c1', displayName: 'Tenant ' + id }
    }

    public static Hive(tenantId: string): FleetHiveDto
    {
        return {
            id: 'h-' + tenantId,
            displayName: 'Hive ' + tenantId,
            tenant: { id: tenantId, displayName: 'Tenant ' + tenantId },
            client: { id: 'c1', displayName: 'Acme' },
            clusterBackend: 'k8s',
            clusterMode: 'single',
            lastSeen: new Date().toISOString(),
            environments: [{ ready: true }] as unknown as FleetHiveDto['environments'],
        }
    }

    public static Model(tenantIds: string[]): ClientDetailViewModel
    {
        return new ClientDetailViewModel(Fixtures.Client, tenantIds.map(Fixtures.Tenant), tenantIds.map(Fixtures.Hive))
    }

    public static Collect(node: unknown, out: unknown[] = []): unknown[]
    {
        out.push(node)
        const children = (node as { Children?: Iterable<unknown> }).Children
        if (children !== undefined)
        {
            for (const c of children)
            {
                Fixtures.Collect(c, out)
            }
        }
        return out
    }
}

describe('ClientDetailView', () =>
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

    it('is populated with a row per tenant', () =>
    {
        const view = new ClientDetailView(Fixtures.Model(['a', 'b']), () => undefined)
        assert.equal(view.Host.State, ScreenState.Populated)
        assert.equal(view.Table?.Rows.length, 2)
    })

    it('shows an empty table for a client with no tenants', () =>
    {
        const view = new ClientDetailView(Fixtures.Model([]), () => undefined)
        assert.equal(view.Host.State, ScreenState.Populated)
        assert.equal(view.Table?.Rows.length, 0)
    })

    it('the back button invokes onBack', () =>
    {
        let calls = 0
        const view = new ClientDetailView(Fixtures.Model(['a']), () => { calls++ })
        const button = Fixtures.Collect(view).find(n => n instanceof KeyActivatedButton) as KeyActivatedButton
        assert.ok(button)
        ;(button as unknown as { OnKeyDown(a: unknown): void }).OnKeyDown({ Key: Key.Return, Handled: false })
        assert.equal(calls, 1)
    })
})
