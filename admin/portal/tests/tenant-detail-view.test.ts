import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Application, Key } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { TenantDetailView } from '../src/tenant-detail-view.js'
import { TenantDetailViewModel } from '../src/tenant-detail-view-model.js'
import { KeyActivatedButton, ScreenState } from '../src/kit/index.js'
import type { ClientDto, FleetHiveDto, TenantDto } from '../src/portal-types.js'

class Fixtures
{
    public static readonly Client: ClientDto = { id: 'c1', displayName: 'Acme', createdAt: '2026-01-02T00:00:00.000Z' }
    public static readonly Tenant: TenantDto = { id: 't1', clientId: 'c1', displayName: 'Tenant t1' }

    public static Hive(): FleetHiveDto
    {
        return {
            id: 'h-t1',
            displayName: 'Hive t1',
            tenant: { id: 't1', displayName: 'Tenant t1' },
            client: { id: 'c1', displayName: 'Acme' },
            clusterBackend: 'k8s',
            clusterMode: 'single',
            lastSeen: new Date().toISOString(),
            environments: [
                { name: 'dev', ready: true, image: 'img:1', detail: 'ok' },
                { name: 'prod', ready: false, detail: 'crash' },
            ] as unknown as FleetHiveDto['environments'],
        }
    }

    public static Model(withHive: boolean): TenantDetailViewModel
    {
        return new TenantDetailViewModel(Fixtures.Tenant, [Fixtures.Client], withHive ? [Fixtures.Hive()] : [])
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

describe('TenantDetailView', () =>
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

    it('is populated with a row per observed environment', () =>
    {
        const view = new TenantDetailView(Fixtures.Model(true), () => undefined)
        assert.equal(view.Host.State, ScreenState.Populated)
        assert.equal(view.EnvTable?.Rows.length, 2)
    })

    it('shows an empty table for a tenant with no hive', () =>
    {
        const view = new TenantDetailView(Fixtures.Model(false), () => undefined)
        assert.equal(view.Host.State, ScreenState.Populated)
        assert.equal(view.EnvTable?.Rows.length, 0)
    })

    it('the back button invokes onBack', () =>
    {
        let calls = 0
        const view = new TenantDetailView(Fixtures.Model(true), () => { calls++ })
        const button = Fixtures.Collect(view).find(n => n instanceof KeyActivatedButton) as KeyActivatedButton
        assert.ok(button)
        ;(button as unknown as { OnKeyDown(a: unknown): void }).OnKeyDown({ Key: Key.Return, Handled: false })
        assert.equal(calls, 1)
    })
})
