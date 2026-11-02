import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ControlPlaneClient } from '../../../api-client.js'
import type { FleetHiveDto } from '../../../portal-types.js'
import { PageState } from '../../../shell/portal-page-view-model.js'
import { FakeControlPlane, PortalTestHost, TestRail, Tick } from '../../../shell/tests/portal-test-fixtures.js'
import { HiveDetailPageViewModel } from '../../hives/hive-detail-page-view-model.js'
import { HivesPageViewModel } from '../../hives/hives-page-view-model.js'
import { HivesSectionService } from '../../hives/hives-section-service.js'
import { FleetPageViewModel } from '../fleet-page-view-model.js'
import { FleetSectionService } from '../fleet-section-service.js'

class FleetClient
{
    public constructor(private readonly hives: FleetHiveDto[])
    {
    }

    public async ListFleet(): Promise<FleetHiveDto[]>
    {
        return this.hives
    }

    public AsClient(): ControlPlaneClient
    {
        return this as unknown as ControlPlaneClient
    }
}

// Answers each ListFleet call with a promise the test resolves by hand.
class PendingFleetClient
{
    public readonly Pending: Array<(hives: FleetHiveDto[]) => void> = []

    public ListFleet(): Promise<FleetHiveDto[]>
    {
        return new Promise(resolve => this.Pending.push(resolve))
    }

    public AsClient(): ControlPlaneClient
    {
        return this as unknown as ControlPlaneClient
    }
}

class Fx
{
    public static Hive(id: string, ready: boolean[]): FleetHiveDto
    {
        return {
            id,
            displayName: 'Hive ' + id,
            tenant: { id: 't', displayName: 'Tenant' },
            client: { id: 'c', displayName: 'Client' },
            clusterBackend: 'k8s',
            clusterMode: 'managed',
            lastSeen: new Date(Date.now() - 60 * 1000).toISOString(),
            environments: ready.map((r, i) => ({ name: 'env' + i, ready: r, detail: '' })),
        } as FleetHiveDto
    }

    public static Page(hives: FleetHiveDto[]): FleetPageViewModel
    {
        return Fx.PageOn(new PortalTestHost(new FleetClient(hives).AsClient()))
    }

    public static PageOn(host: PortalTestHost): FleetPageViewModel
    {
        return new FleetPageViewModel(host.Session, new FleetSectionService(host.Provider))
    }
}

describe('FleetPageViewModel', () =>
{
    it('two hives, one needing attention -> Populated with counts, attention and rows', async () =>
    {
        const page = Fx.Page([Fx.Hive('a', [true, true]), Fx.Hive('b', [true, false])])
        await page.Refresh()
        assert.equal(page.State, PageState.Populated)
        assert.equal(page.HiveCount, 2)
        assert.equal(page.NeedAttentionCount, 1)
        assert.equal(page.NotCheckingInCount, 0)
        assert.equal(page.EnvironmentsObserved, 4)
        assert.equal(page.HiveCountText, '2')
        assert.equal(page.NeedAttentionCountText, '1')
        assert.equal(page.NotCheckingInCountText, '0')
        assert.equal(page.EnvironmentsObservedText, '4')
        assert.equal(page.NeedsAttention.Count, 1)
        assert.equal(page.NeedsAttention.Get(0)?.DisplayName, 'Hive b')
        assert.equal(page.NeedsAttention.Get(0)?.IssuesText, '1 environment not ready')
        assert.equal(page.Rows.Count, 2)
        assert.equal(page.Rows.Get(0)?.DisplayName, 'Hive a')
        assert.equal(page.Rows.Get(0)?.OwnerLabel, 'Client / Tenant')
        assert.equal(page.Rows.Get(0)?.ConnectionLabel, 'Connected')
        assert.equal(page.Rows.Get(1)?.EnvironmentsLabel, '1 of 2 ready')
        assert.equal(page.HasNeedsAttention, true)
    })

    it('an empty fleet -> Empty', async () =>
    {
        const page = Fx.Page([])
        await page.Refresh()
        assert.equal(page.State, PageState.Empty)
        assert.equal(page.Rows.Count, 0)
        assert.equal(page.HasNeedsAttention, false)
    })

    it('an older load settling last does not overwrite the newer rows', async () =>
    {
        const client = new PendingFleetClient()
        const page = Fx.PageOn(new PortalTestHost(client.AsClient()))
        const first = page.Refresh()
        const second = page.Refresh()
        client.Pending[1]([Fx.Hive('new', [true])])
        await second
        client.Pending[0]([Fx.Hive('old1', [true]), Fx.Hive('old2', [true])])
        await first
        assert.equal(page.State, PageState.Populated)
        assert.equal(page.Rows.Count, 1)
        assert.equal(page.Rows.Get(0)?.DisplayName, 'Hive new')
    })

    it('the section presents a Fleet page as its root', () =>
    {
        const host = new PortalTestHost(new FleetClient([]).AsClient())
        const section = new FleetSectionService(host.Provider)
        section.OnActivated()
        assert.ok(host.Host.Content instanceof FleetPageViewModel)
    })

    it('opening a hive row shows its detail in the Hives section, over the hives list', async () =>
    {
        const api = new FakeControlPlane().WithClient('c').WithTenant('t', 'c').WithHive('h1', 't')
        const host = new PortalTestHost(api.AsClient())
        host.Provider.register(FleetSectionService.Key, (p) => new FleetSectionService(p))
        host.Provider.register(HivesSectionService.Key, (p) => new HivesSectionService(p))
        const rail = new TestRail(host.Provider)
        rail.Add(FleetSectionService)
        rail.Add(HivesSectionService)
        rail.Select(FleetSectionService)
        await Tick.Settle()
        const fleet = host.Host.Content as FleetPageViewModel
        fleet.Rows.Get(0)?.OpenCommand.Execute()
        await Tick.Settle()
        const hives = host.Provider.getRequired(HivesSectionService.Key)
        assert.equal(rail.Navigation.ActiveService, hives)
        const detail = host.Host.Content
        assert.ok(detail instanceof HiveDetailPageViewModel)
        assert.equal(detail.Id, 'h1')
        assert.equal(detail.State, PageState.Populated)
        hives.BackCommand.Execute()
        assert.ok(host.Host.Content instanceof HivesPageViewModel)
    })
})
