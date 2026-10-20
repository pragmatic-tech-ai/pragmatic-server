import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ControlPlaneClient } from '../src/api-client.js'
import type { SecurityModelDto } from '../src/portal-types.js'

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

describe('ControlPlaneClient create', () =>
{
    afterEach(() => { FetchStub.Restore() })

    it('CreateEnvironment posts the type in the body', async () =>
    {
        FetchStub.Install({})
        await new ControlPlaneClient().CreateEnvironment('e1', 'dev-blank', 'development', 8080)
        const call = FetchStub.Calls[0]!
        assert.deepEqual(JSON.parse(call.init?.body as string), { name: 'e1', template: 'dev-blank', type: 'development', hostPort: 8080 })
    })
})

describe('ControlPlaneClient security model', () =>
{
    afterEach(() => { FetchStub.Restore() })

    it('GetSecurityModel GETs the security-model route and returns the payload', async () =>
    {
        const model = { roles: [] }
        FetchStub.Install(model)
        assert.deepEqual(await new ControlPlaneClient().GetSecurityModel('my env'), model)
        assert.equal(FetchStub.Calls[0]!.route, '/api/environments/my%20env/admin/security-model')
        assert.equal(FetchStub.Calls[0]!.init?.method, undefined)
    })

    it('GetSecurityModel passes a null payload through', async () =>
    {
        FetchStub.Install(null)
        assert.equal(await new ControlPlaneClient().GetSecurityModel('e'), null)
    })

    it('SetSecurityModel PUTs { securityModel } to the security-model route', async () =>
    {
        FetchStub.Install({ ok: true })
        const model = { businessUnits: [], teams: [], membership: {}, ownershipRules: [], roles: [] } as SecurityModelDto
        await new ControlPlaneClient().SetSecurityModel('e', model)
        const call = FetchStub.Calls[0]!
        assert.equal(call.route, '/api/environments/e/admin/security-model')
        assert.equal(call.init?.method, 'PUT')
        assert.deepEqual(JSON.parse(call.init?.body as string), { securityModel: model })
    })
})

describe('ControlPlaneClient maker token', () =>
{
    afterEach(() => { FetchStub.Restore() })

    it('IssueMakerToken POSTs to the maker-token route and returns the parsed token', async () =>
    {
        const issued = { token: 'tok-abc', principalId: 'maker-1', expiresAt: null }
        FetchStub.Install(issued)
        const result = await new ControlPlaneClient().IssueMakerToken('envX')
        assert.equal(FetchStub.Calls[0]!.route, '/api/environments/envX/maker-token')
        assert.equal(FetchStub.Calls[0]!.init?.method, 'POST')
        assert.deepEqual(result, issued)
    })
})

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
