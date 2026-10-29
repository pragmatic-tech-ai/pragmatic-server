import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ControlPlaneClient } from '../src/api-client.js'
import type { GatingDto, HiveDto, HiveRolloutDto, ManifestDto, OperatorSummaryDto, SelectionDto, TenantDto } from '../src/portal-types.js'

type Recorded = { route: string; init: RequestInit | undefined }

class FetchStub
{
    public static readonly Original = globalThis.fetch
    public static Calls: Recorded[] = []

    public static Install(payload: unknown): void
    {
        FetchStub.Calls = []
        globalThis.fetch = (async (route: string, init?: RequestInit) =>
        {
            FetchStub.Calls.push({ route, init })
            return { ok: true, status: 200, json: async () => payload } as Response
        }) as typeof fetch
    }

    public static Restore(): void
    {
        globalThis.fetch = FetchStub.Original
    }
}

describe('ControlPlaneClient platform records', () =>
{
    afterEach(() => { FetchStub.Restore() })

    it('ListClients GETs /api/clients', async () =>
    {
        FetchStub.Install([{ id: 'c1', displayName: 'Acme' }])
        const clients = await new ControlPlaneClient().ListClients()
        assert.equal(FetchStub.Calls[0]!.route, '/api/clients')
        assert.equal(FetchStub.Calls[0]!.init?.method, undefined)
        assert.deepEqual(clients, [{ id: 'c1', displayName: 'Acme' }])
    })

    it('CreateClient POSTs the body', async () =>
    {
        FetchStub.Install({ id: 'c1', displayName: 'Acme', subscriptionRef: 'sub' })
        const dto = await new ControlPlaneClient().CreateClient('c1', 'Acme', 'sub')
        const call = FetchStub.Calls[0]!
        assert.equal(call.route, '/api/clients')
        assert.equal(call.init?.method, 'POST')
        assert.deepEqual(JSON.parse(call.init?.body as string), { id: 'c1', displayName: 'Acme', subscriptionRef: 'sub' })
        assert.equal(dto.id, 'c1')
    })

    it('CreateClient omits an absent subscriptionRef', async () =>
    {
        FetchStub.Install({ id: 'c1', displayName: 'Acme' })
        await new ControlPlaneClient().CreateClient('c1', 'Acme')
        assert.deepEqual(JSON.parse(FetchStub.Calls[0]!.init?.body as string), { id: 'c1', displayName: 'Acme' })
    })

    it('DeleteClient DELETEs the item route', async () =>
    {
        FetchStub.Install({ ok: true })
        await new ControlPlaneClient().DeleteClient('c 1')
        assert.equal(FetchStub.Calls[0]!.route, '/api/clients/c%201')
        assert.equal(FetchStub.Calls[0]!.init?.method, 'DELETE')
    })

    it('ListTenants returns all when no client is given', async () =>
    {
        const all: TenantDto[] = [{ id: 't1', clientId: 'c1', displayName: 'T1' }, { id: 't2', clientId: 'c2', displayName: 'T2' }]
        FetchStub.Install(all)
        const result = await new ControlPlaneClient().ListTenants()
        assert.equal(FetchStub.Calls[0]!.route, '/api/tenants')
        assert.deepEqual(result, all)
    })

    it('ListTenants filters client-side by clientId', async () =>
    {
        FetchStub.Install([{ id: 't1', clientId: 'c1', displayName: 'T1' }, { id: 't2', clientId: 'c2', displayName: 'T2' }])
        const result = await new ControlPlaneClient().ListTenants('c2')
        assert.deepEqual(result.map(t => t.id), ['t2'])
    })

    it('CreateTenant POSTs the body', async () =>
    {
        FetchStub.Install({ id: 't1', clientId: 'c1', displayName: 'T1' })
        const dto = await new ControlPlaneClient().CreateTenant('t1', 'c1', 'T1')
        const call = FetchStub.Calls[0]!
        assert.equal(call.route, '/api/tenants')
        assert.equal(call.init?.method, 'POST')
        assert.deepEqual(JSON.parse(call.init?.body as string), { id: 't1', clientId: 'c1', displayName: 'T1' })
        assert.equal(dto.clientId, 'c1')
    })

    it('DeleteTenant DELETEs the item route', async () =>
    {
        FetchStub.Install({ ok: true })
        await new ControlPlaneClient().DeleteTenant('t1')
        assert.equal(FetchStub.Calls[0]!.route, '/api/tenants/t1')
        assert.equal(FetchStub.Calls[0]!.init?.method, 'DELETE')
    })

    it('ListHives filters client-side by tenantId', async () =>
    {
        const hive = (id: string, tenantId: string): HiveDto => ({ id, tenantId, displayName: id, cluster: { backend: 'local', mode: 'attach' }, registry: { mode: 'attach' } })
        FetchStub.Install([hive('h1', 't1'), hive('h2', 't2')])
        const client = new ControlPlaneClient()
        assert.deepEqual((await client.ListHives('t1')).map(h => h.id), ['h1'])
        assert.equal(FetchStub.Calls[0]!.route, '/api/hives')
        assert.equal((await client.ListHives()).length, 2)
    })

    it('CreateHive POSTs the full input', async () =>
    {
        const input: HiveDto = { id: 'h1', tenantId: 't1', displayName: 'H', cluster: { backend: 'aks', mode: 'provision', configRef: 'cfg' }, registry: { mode: 'attach', endpoint: 'e', credentialRef: 'k' }, trustRootRef: 'root' }
        FetchStub.Install(input)
        const dto = await new ControlPlaneClient().CreateHive(input)
        const call = FetchStub.Calls[0]!
        assert.equal(call.route, '/api/hives')
        assert.equal(call.init?.method, 'POST')
        assert.deepEqual(JSON.parse(call.init?.body as string), input)
        assert.equal(dto.cluster.backend, 'aks')
    })

    it('DeleteHive DELETEs the item route', async () =>
    {
        FetchStub.Install({ ok: true })
        await new ControlPlaneClient().DeleteHive('h1')
        assert.equal(FetchStub.Calls[0]!.route, '/api/hives/h1')
        assert.equal(FetchStub.Calls[0]!.init?.method, 'DELETE')
    })

    it('ListManifests GETs /api/manifests and returns the parsed array', async () =>
    {
        const payload: ManifestDto[] = [{ id: 'v1', image: 'img1', publishedAt: '2026-01-01T00:00:00.000Z' }]
        FetchStub.Install(payload)
        const manifests = await new ControlPlaneClient().ListManifests()
        const call = FetchStub.Calls[0]!
        assert.equal(call.route, '/api/manifests')
        assert.equal(call.init?.method, undefined)
        assert.equal(call.init?.body, undefined)
        assert.equal(call.init?.credentials, 'same-origin')
        assert.deepEqual(manifests, payload)
    })

    it('PublishManifest POSTs version, image and notes', async () =>
    {
        FetchStub.Install({ id: '1.2.0', image: 'img:1.2.0', publishedAt: '2026-01-01T00:00:00.000Z' })
        const dto = await new ControlPlaneClient().PublishManifest('1.2.0', 'img:1.2.0', 'note')
        const call = FetchStub.Calls[0]!
        assert.equal(call.route, '/api/manifests')
        assert.equal(call.init?.method, 'POST')
        assert.deepEqual(JSON.parse(call.init?.body as string), { version: '1.2.0', image: 'img:1.2.0', notes: 'note' })
        assert.equal(dto.id, '1.2.0')
    })

    it('PublishManifest omits absent or blank notes', async () =>
    {
        FetchStub.Install({ id: '1.2.0', image: 'img:1.2.0', publishedAt: '2026-01-01T00:00:00.000Z' })
        const client = new ControlPlaneClient()
        await client.PublishManifest('1.2.0', 'img:1.2.0')
        await client.PublishManifest('1.2.0', 'img:1.2.0', '')
        assert.deepEqual(JSON.parse(FetchStub.Calls[0]!.init?.body as string), { version: '1.2.0', image: 'img:1.2.0' })
        assert.deepEqual(JSON.parse(FetchStub.Calls[1]!.init?.body as string), { version: '1.2.0', image: 'img:1.2.0' })
    })

    it('Gate POSTs the version to the tenant gating route', async () =>
    {
        FetchStub.Install({})
        await new ControlPlaneClient().Gate('t1', '1.2.0')
        const call = FetchStub.Calls[0]!
        assert.equal(call.route, '/api/tenants/t1/gating')
        assert.equal(call.init?.method, 'POST')
        assert.deepEqual(JSON.parse(call.init?.body as string), { version: '1.2.0' })
    })

    it('Ungate DELETEs the gating item route', async () =>
    {
        FetchStub.Install({})
        await new ControlPlaneClient().Ungate('t1', '1.2.0')
        assert.equal(FetchStub.Calls[0]!.route, '/api/tenants/t1/gating/1.2.0')
        assert.equal(FetchStub.Calls[0]!.init?.method, 'DELETE')
    })

    it('Ungate path-encodes the version', async () =>
    {
        FetchStub.Install({})
        await new ControlPlaneClient().Ungate('t1', 'a/b+c')
        assert.equal(FetchStub.Calls[0]!.route, '/api/tenants/t1/gating/a%2Fb%2Bc')
    })

    it('SetManifestWithdrawn(true) POSTs the withdrawn route with no body', async () =>
    {
        FetchStub.Install({ id: '1.0.0', image: 'img:1.0.0', publishedAt: '2026-01-01T00:00:00.000Z' })
        const dto = await new ControlPlaneClient().SetManifestWithdrawn('1.0.0', true)
        const call = FetchStub.Calls[0]!
        assert.equal(call.route, '/api/manifests/1.0.0/withdrawn')
        assert.equal(call.init?.method, 'POST')
        assert.equal(call.init?.body, undefined)
        assert.equal(dto.id, '1.0.0')
    })

    it('SetManifestWithdrawn(false) DELETEs the withdrawn route', async () =>
    {
        FetchStub.Install({ id: '1.0.0', image: 'img:1.0.0', publishedAt: '2026-01-01T00:00:00.000Z' })
        await new ControlPlaneClient().SetManifestWithdrawn('1.0.0', false)
        assert.equal(FetchStub.Calls[0]!.route, '/api/manifests/1.0.0/withdrawn')
        assert.equal(FetchStub.Calls[0]!.init?.method, 'DELETE')
    })

    it('SetManifestWithdrawn path-encodes the version', async () =>
    {
        FetchStub.Install({ id: 'a/b', image: 'i', publishedAt: '2026-01-01T00:00:00.000Z' })
        await new ControlPlaneClient().SetManifestWithdrawn('a/b', true)
        assert.equal(FetchStub.Calls[0]!.route, '/api/manifests/a%2Fb/withdrawn')
    })

    it('ListOperators GETs /api/operators and returns the parsed array', async () =>
    {
        const payload: OperatorSummaryDto[] = [{ email: 'a@b.c', role: 'full' }, { email: 'd@e.f', role: 'readonly' }]
        FetchStub.Install(payload)
        const operators = await new ControlPlaneClient().ListOperators()
        const call = FetchStub.Calls[0]!
        assert.equal(call.route, '/api/operators')
        assert.equal(call.init?.method, undefined)
        assert.equal(call.init?.body, undefined)
        assert.equal(call.init?.credentials, 'same-origin')
        assert.deepEqual(operators, payload)
    })

    it('ListGating GETs /api/gating and returns the parsed array', async () =>
    {
        const payload: GatingDto[] = [{ tenantId: 't1', version: 'v1', gatedAt: '2026-01-01T00:00:00.000Z' }]
        FetchStub.Install(payload)
        const gating = await new ControlPlaneClient().ListGating()
        const call = FetchStub.Calls[0]!
        assert.equal(call.route, '/api/gating')
        assert.equal(call.init?.method, undefined)
        assert.equal(call.init?.body, undefined)
        assert.equal(call.init?.credentials, 'same-origin')
        assert.deepEqual(gating, payload)
    })

    it('ListSelections GETs /api/selections and returns the parsed array', async () =>
    {
        const payload: SelectionDto[] = [{ hiveId: 'h1', targetVersion: 'v1', selectedAt: '2026-01-01T00:00:00.000Z' }]
        FetchStub.Install(payload)
        const selections = await new ControlPlaneClient().ListSelections()
        const call = FetchStub.Calls[0]!
        assert.equal(call.route, '/api/selections')
        assert.equal(call.init?.method, undefined)
        assert.equal(call.init?.body, undefined)
        assert.equal(call.init?.credentials, 'same-origin')
        assert.deepEqual(selections, payload)
    })

    it('ListRollouts GETs /api/rollouts and returns the parsed array', async () =>
    {
        const payload: HiveRolloutDto[] = [{ hiveId: 'h1', targetVersion: 'v1', environments: [{ environmentName: 'prod', runningImage: 'img:1', obsolete: false, ready: true }] }]
        FetchStub.Install(payload)
        const rollouts = await new ControlPlaneClient().ListRollouts()
        const call = FetchStub.Calls[0]!
        assert.equal(call.route, '/api/rollouts')
        assert.equal(call.init?.method, undefined)
        assert.equal(call.init?.body, undefined)
        assert.equal(call.init?.credentials, 'same-origin')
        assert.deepEqual(rollouts, payload)
    })
})
