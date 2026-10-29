import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ProvisionInputDto, ProvisionResultDto } from '../src/portal-types.js'
import { ControlPlaneClient } from '../src/api-client.js'

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

describe('ControlPlaneClient graphs', () =>
{
    afterEach(() => { FetchStub.Restore() })

    it('CreateGraph posts name+description to the nested env graphs route', async () =>
    {
        FetchStub.Install({})
        await new ControlPlaneClient().CreateGraph('dev1', 'g1', 'first')
        const call = FetchStub.Calls[0]!
        assert.equal(call.route, '/api/environments/dev1/graphs')
        assert.equal(call.init?.method, 'POST')
        assert.deepEqual(JSON.parse(call.init?.body as string), { name: 'g1', description: 'first' })
    })

    it('ListGraphs GETs the nested env graphs route', async () =>
    {
        FetchStub.Install([])
        await new ControlPlaneClient().ListGraphs('dev1')
        assert.equal(FetchStub.Calls[0]!.route, '/api/environments/dev1/graphs')
        assert.equal(FetchStub.Calls[0]!.init?.method, undefined)
    })

    it('DeleteGraph DELETEs the graph under the nested env graphs route', async () =>
    {
        FetchStub.Install({})
        await new ControlPlaneClient().DeleteGraph('dev1', 'g1')
        assert.equal(FetchStub.Calls[0]!.route, '/api/environments/dev1/graphs/g1')
        assert.equal(FetchStub.Calls[0]!.init?.method, 'DELETE')
    })
})

describe('ControlPlaneClient promotion', () =>
{
    afterEach(() => { FetchStub.Restore() })

    it('PromoteGraph POSTs the target env to the graph promote route', async () =>
    {
        const result = { graphName: 'g1', packageCount: 2, targetEnv: 'rt1' }
        FetchStub.Install(result)
        const dto = await new ControlPlaneClient().PromoteGraph('dev1', 'g1', 'rt1')
        const call = FetchStub.Calls[0]!
        assert.equal(call.route, '/api/environments/dev1/graphs/g1/promote')
        assert.equal(call.init?.method, 'POST')
        assert.equal(call.init?.body, '{"targetEnv":"rt1"}')
        assert.deepEqual(dto, result)
    })

    it('GetLoadedGraph GETs the loaded-graph route and returns the dto', async () =>
    {
        const loaded = { name: 'g1', packages: [{ id: 'p', version: '1.0.0' }], promotedAt: '2026-10-20T00:00:00Z' }
        FetchStub.Install(loaded)
        const dto = await new ControlPlaneClient().GetLoadedGraph('rt1')
        assert.equal(FetchStub.Calls[0]!.route, '/api/environments/rt1/loaded-graph')
        assert.equal(FetchStub.Calls[0]!.init?.method, undefined)
        assert.deepEqual(dto, loaded)
    })

    it('GetLoadedGraph returns null when nothing is loaded', async () =>
    {
        FetchStub.Install(null)
        assert.equal(await new ControlPlaneClient().GetLoadedGraph('rt1'), null)
    })
})

describe('ControlPlaneClient provisioning', () =>
{
    afterEach(() => { FetchStub.Restore() })

    it('Provision POSTs the composed input to /api/provision and returns the result with secrets', async () =>
    {
        const input: ProvisionInputDto =
        {
            client: { id: 'c1', displayName: 'Client 1' },
            tenant: { id: 't1', displayName: 'Tenant 1', ownerEmail: 'owner@example.com' },
            hive: { id: 'h1', displayName: 'Hive 1', cluster: { backend: 'local', mode: 'attach' }, registry: { mode: 'attach', endpoint: 'reg.example.com' } }
        }
        const result: ProvisionResultDto =
        {
            client: { id: 'c1', displayName: 'Client 1', createdAt: '2026-10-29T00:00:00Z' },
            tenant: { id: 't1', clientId: 'c1', displayName: 'Tenant 1' },
            hive: { id: 'h1', tenantId: 't1', displayName: 'Hive 1', cluster: { backend: 'local', mode: 'attach' }, registry: { mode: 'attach', endpoint: 'reg.example.com' } },
            secrets: { ownerEmail: 'owner@example.com', ownerPassword: 'pw-123', agentToken: 'tok-456' }
        }
        FetchStub.Install(result)
        const dto = await new ControlPlaneClient().Provision(input)
        const call = FetchStub.Calls[0]!
        assert.ok(call.route.endsWith('/api/provision'))
        assert.equal(call.init?.method, 'POST')
        assert.deepEqual(JSON.parse(call.init?.body as string), input)
        assert.equal(dto.secrets.ownerPassword, 'pw-123')
        assert.equal(dto.secrets.agentToken, 'tok-456')
        assert.deepEqual(dto, result)
    })
})

describe('ControlPlaneClient release policy', () =>
{
    afterEach(() => { FetchStub.Restore() })

    it('ListPolicies GETs /api/policies', async () =>
    {
        FetchStub.Install([{ tenantId: 't1' }])
        const out = await new ControlPlaneClient().ListPolicies()
        assert.equal(FetchStub.Calls[0]!.route, '/api/policies')
        assert.equal(FetchStub.Calls[0]!.init?.method, undefined)
        assert.deepEqual(out, [{ tenantId: 't1' }])
    })

    it('SetTenantChannels PUTs channels', async () =>
    {
        FetchStub.Install({ tenantId: 't1', channels: ['stable', 'early'] })
        const out = await new ControlPlaneClient().SetTenantChannels('t1', ['stable', 'early'])
        const call = FetchStub.Calls[0]!
        assert.equal(call.route, '/api/tenants/t1/policy/channels')
        assert.equal(call.init?.method, 'PUT')
        assert.deepEqual(JSON.parse(call.init?.body as string), { channels: ['stable', 'early'] })
        assert.deepEqual(out, { tenantId: 't1', channels: ['stable', 'early'] })
    })

    it('SetTenantMinVersion PUTs version', async () =>
    {
        FetchStub.Install({ tenantId: 't1', minVersion: '1.2.0' })
        const out = await new ControlPlaneClient().SetTenantMinVersion('t1', '1.2.0')
        const call = FetchStub.Calls[0]!
        assert.equal(call.route, '/api/tenants/t1/policy/min-version')
        assert.equal(call.init?.method, 'PUT')
        assert.deepEqual(JSON.parse(call.init?.body as string), { version: '1.2.0' })
        assert.deepEqual(out, { tenantId: 't1', minVersion: '1.2.0' })
    })

    it('ClearTenantMinVersion DELETEs without body', async () =>
    {
        FetchStub.Install({ tenantId: 't1' })
        const out = await new ControlPlaneClient().ClearTenantMinVersion('t1')
        const call = FetchStub.Calls[0]!
        assert.equal(call.route, '/api/tenants/t1/policy/min-version')
        assert.equal(call.init?.method, 'DELETE')
        assert.equal(call.init?.body, undefined)
        assert.deepEqual(out, { tenantId: 't1' })
    })

    it('SetTenantHold POSTs reason', async () =>
    {
        const hold = { reason: 'incident', actor: 'a', at: 'now' }
        FetchStub.Install({ tenantId: 't1', hold })
        const out = await new ControlPlaneClient().SetTenantHold('t1', 'incident')
        const call = FetchStub.Calls[0]!
        assert.equal(call.route, '/api/tenants/t1/policy/hold')
        assert.equal(call.init?.method, 'POST')
        assert.deepEqual(JSON.parse(call.init?.body as string), { reason: 'incident' })
        assert.deepEqual(out, { tenantId: 't1', hold })
    })

    it('ClearTenantHold DELETEs without body', async () =>
    {
        FetchStub.Install({ tenantId: 't1' })
        const out = await new ControlPlaneClient().ClearTenantHold('t1')
        const call = FetchStub.Calls[0]!
        assert.equal(call.route, '/api/tenants/t1/policy/hold')
        assert.equal(call.init?.method, 'DELETE')
        assert.equal(call.init?.body, undefined)
        assert.deepEqual(out, { tenantId: 't1' })
    })
})
