import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError, TenantApiClient } from '../tenant-api-client.js'
import type { IWebSocketFactory, IWebSocketLike } from '../tenant-types.js'

type Recorded = { url: string; init: RequestInit }

class ConfigurationFetch
{
    public readonly Calls: Recorded[] = []

    public constructor(private readonly status: number, private readonly body: unknown)
    {
    }

    public Client(): TenantApiClient
    {
        return new TenantApiClient(new NoSockets(), async (url, init) =>
        {
            this.Calls.push({ url, init })
            return { ok: this.status < 300, status: this.status, json: async () => this.body } as Response
        })
    }

    public get Last(): Recorded
    {
        return this.Calls[this.Calls.length - 1]!
    }
}

class NoSockets implements IWebSocketFactory
{
    public readonly Location = { protocol: 'http:', host: 'host' }

    public Open(): IWebSocketLike
    {
        throw new Error('no sockets')
    }
}

describe('TenantApiClient configuration', () =>
{
    it('lists the components', async () =>
    {
        const f = new ConfigurationFetch(200, [{ component: 'graph', componentVersion: '1.2.0', descriptorDigest: 'd', head: 2, targets: [] }])
        const list = await f.Client().ListConfigurationComponents()
        assert.equal(f.Last.url, '/tenant-api/configuration/components')
        assert.equal(f.Last.init.method, 'GET')
        assert.equal(list[0]?.head, 2)
    })

    it('reads a component, one version and a diff, path-encoding the component', async () =>
    {
        const f = new ConfigurationFetch(200, {})
        const client = f.Client()
        await client.GetConfigurationComponent('my comp')
        assert.equal(f.Last.url, '/tenant-api/configuration/components/my%20comp')
        await client.GetConfigurationVersion('my comp', 3)
        assert.equal(f.Last.url, '/tenant-api/configuration/components/my%20comp/versions/3')
        await client.DiffConfigurationVersions('my comp', 0, 3)
        assert.equal(f.Last.url, '/tenant-api/configuration/components/my%20comp/diff?from=0&to=3')
    })

    it('saves a version based on the head, with its document and comment', async () =>
    {
        const f = new ConfigurationFetch(201, { version: 4 })
        const saved = await f.Client().SaveConfigurationVersion('graph', 3, { a: 1 }, 'raise the limit')
        assert.equal(f.Last.url, '/tenant-api/configuration/components/graph/versions')
        assert.equal(f.Last.init.method, 'POST')
        assert.deepEqual(JSON.parse(f.Last.init.body as string), { basedOn: 3, document: { a: 1 }, comment: 'raise the limit' })
        assert.equal(saved.version, 4)
    })

    it("a refused save keeps the server's body (validation errors, the moved head) on the ApiError", async () =>
    {
        const f = new ConfigurationFetch(422, { error: 'invalid', errors: [{ path: 'db.url', message: 'required' }] })
        const err = await f.Client().SaveConfigurationVersion('graph', 3, {}, '').then(() => undefined, (e: unknown) => e)
        assert.ok(err instanceof ApiError)
        assert.equal(err.Status, 422)
        assert.deepEqual(err.Body?.errors, [{ path: 'db.url', message: 'required' }])
    })

    it('applies a version to one target environment', async () =>
    {
        const f = new ConfigurationFetch(200, { id: 'a1', outcome: 'applied' })
        await f.Client().ApplyConfigurationVersion('graph', 3, 'production')
        assert.equal(f.Last.url, '/tenant-api/configuration/components/graph/versions/3/apply')
        assert.equal(f.Last.init.method, 'POST')
        assert.deepEqual(JSON.parse(f.Last.init.body as string), { environment: 'production' })
    })
})
