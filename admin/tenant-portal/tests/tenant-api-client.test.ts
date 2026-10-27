import { afterEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { TenantApiClient, TenantApiError } from '../src/tenant-api-client.js'
import { TenantEventType } from '../src/tenant-types.js'
import type { IWebSocketFactory, IWebSocketLike, TenantEvent } from '../src/tenant-types.js'

type Recorded = { route: string; init: RequestInit | undefined }

class FetchStub
{
    public static readonly Original = globalThis.fetch
    public static Calls: Recorded[] = []

    public static Install(payload: unknown, status = 200): void
    {
        FetchStub.Calls = []
        globalThis.fetch = (async (route: string, init?: RequestInit) =>
        {
            FetchStub.Calls.push({ route, init })
            return { ok: status >= 200 && status < 300, status, json: async () => payload } as Response
        }) as typeof fetch
    }

    public static Restore(): void
    {
        globalThis.fetch = FetchStub.Original
    }
}

class FakeWebSocket implements IWebSocketLike
{
    public Closed = false
    private message: ((data: string) => void) | undefined
    private close: (() => void) | undefined

    public OnMessage(cb: (data: string) => void): void
    {
        this.message = cb
    }

    public OnClose(cb: () => void): void
    {
        this.close = cb
    }

    public Close(): void
    {
        this.Closed = true
    }

    public Push(data: string): void
    {
        this.message?.(data)
    }

    public FireClose(): void
    {
        this.close?.()
    }
}

class FakeWebSocketFactory implements IWebSocketFactory
{
    public readonly Urls: string[] = []
    public readonly Sockets: FakeWebSocket[] = []

    public Open(url: string): IWebSocketLike
    {
        const socket = new FakeWebSocket()
        this.Urls.push(url)
        this.Sockets.push(socket)
        return socket
    }
}

// Test subclass: captures navigation and supplies a fixed ws base (no browser location in node).
class TestClient extends TenantApiClient
{
    public Navigated: string | undefined

    protected override Navigate(url: string): void
    {
        this.Navigated = url
    }

    protected override WsBase(): string
    {
        return 'ws://host'
    }
}

describe('TenantApiClient fetch', () =>
{
    afterEach(() => { FetchStub.Restore() })

    it('Session returns the DTO on 200', async () =>
    {
        const dto = { tenantId: 't', principalId: 'p', email: 'a@b' }
        FetchStub.Install(dto)
        assert.deepEqual(await new TestClient(new FakeWebSocketFactory()).Session(), dto)
        assert.equal(FetchStub.Calls[0]!.route, '/tenant-auth/session')
    })

    it('Session returns null on 401', async () =>
    {
        FetchStub.Install({ error: 'no' }, 401)
        assert.equal(await new TestClient(new FakeWebSocketFactory()).Session(), null)
    })

    it('Logout POSTs to the logout route', async () =>
    {
        FetchStub.Install({})
        await new TestClient(new FakeWebSocketFactory()).Logout()
        assert.equal(FetchStub.Calls[0]!.route, '/tenant-auth/logout')
        assert.equal(FetchStub.Calls[0]!.init?.method, 'POST')
    })

    it('ListHives, ListEnvironments and ListManifests hit their routes', async () =>
    {
        const c = new TestClient(new FakeWebSocketFactory())
        FetchStub.Install([{ id: 'h' }])
        assert.deepEqual(await c.ListHives(), [{ id: 'h' }])
        assert.equal(FetchStub.Calls[0]!.route, '/tenant-api/hives')
        FetchStub.Install([])
        await c.ListEnvironments()
        assert.equal(FetchStub.Calls[0]!.route, '/tenant-api/environments')
        FetchStub.Install([{ id: 'm' }])
        assert.deepEqual(await c.ListManifests(), [{ id: 'm' }])
        assert.equal(FetchStub.Calls[0]!.route, '/tenant-api/manifests')
    })

    it('GetRollout and GetHealth hit the hive sub-routes', async () =>
    {
        const c = new TestClient(new FakeWebSocketFactory())
        const rollout = { targetVersion: 'v1', environments: [] }
        FetchStub.Install(rollout)
        assert.deepEqual(await c.GetRollout('h 1'), rollout)
        assert.equal(FetchStub.Calls[0]!.route, '/tenant-api/hives/h%201/rollout')
        FetchStub.Install([{ environmentName: 'e', ready: true }])
        assert.equal((await c.GetHealth('h1')).length, 1)
        assert.equal(FetchStub.Calls[0]!.route, '/tenant-api/hives/h1/health')
    })

    it('SelectTarget POSTs the version body', async () =>
    {
        FetchStub.Install({})
        await new TestClient(new FakeWebSocketFactory()).SelectTarget('h1', 'v2')
        const call = FetchStub.Calls[0]!
        assert.equal(call.route, '/tenant-api/hives/h1/target')
        assert.equal(call.init?.method, 'POST')
        assert.deepEqual(JSON.parse(call.init?.body as string), { version: 'v2' })
    })

    it('SelectTarget maps a 409 to TenantApiError', async () =>
    {
        FetchStub.Install({ error: 'conflict' }, 409)
        await assert.rejects(new TestClient(new FakeWebSocketFactory()).SelectTarget('h1', 'v2'), (e: unknown) =>
            e instanceof TenantApiError && e.Status === 409 && e.message === 'conflict')
    })

    it('StartEnvironment POSTs to the start route and returns the DTO', async () =>
    {
        const env = { name: 'e1', status: 'running' }
        FetchStub.Install(env)
        const c = new TestClient(new FakeWebSocketFactory())
        assert.deepEqual(await c.StartEnvironment('e1'), env)
        assert.equal(FetchStub.Calls[0]!.route, '/tenant-api/environments/e1/start')
        assert.equal(FetchStub.Calls[0]!.init?.method, 'POST')
        await c.StopEnvironment('e1')
        assert.equal(FetchStub.Calls[1]!.route, '/tenant-api/environments/e1/stop')
        await c.RestartEnvironment('e1')
        assert.equal(FetchStub.Calls[2]!.route, '/tenant-api/environments/e1/restart')
    })
})

describe('TenantApiClient admin (users and access)', () =>
{
    afterEach(() => { FetchStub.Restore() })

    it('GetAdminSnapshot GETs the snapshot route and returns accounts + grants', async () =>
    {
        const snap = { accounts: [{ principalId: 'p1', email: 'a@b', disabled: false }], grants: [{ subject: 'p1', role: 'Admin', resourceKind: 'Tenant', resourcePath: [] }] }
        FetchStub.Install(snap)
        assert.deepEqual(await new TestClient(new FakeWebSocketFactory()).GetAdminSnapshot('envA'), snap)
        assert.equal(FetchStub.Calls[0]!.route, '/tenant-api/environments/envA/admin/snapshot')
        assert.equal(FetchStub.Calls[0]!.init?.method, undefined)
    })

    it('CreateAccount POSTs the body and resolves on 201', async () =>
    {
        FetchStub.Install({ ok: true }, 201)
        const params = { email: 'a@b', principalId: 'p1', password: 'pw' }
        await new TestClient(new FakeWebSocketFactory()).CreateAccount('envA', params)
        const call = FetchStub.Calls[0]!
        assert.equal(call.route, '/tenant-api/environments/envA/admin/accounts')
        assert.equal(call.init?.method, 'POST')
        assert.deepEqual(JSON.parse(call.init?.body as string), params)
        assert.deepEqual(call.init?.headers, { 'content-type': 'application/json' })
    })

    it('DisableAccount DELETEs the account route', async () =>
    {
        FetchStub.Install({ ok: true })
        await new TestClient(new FakeWebSocketFactory()).DisableAccount('envA', 'p1')
        assert.equal(FetchStub.Calls[0]!.route, '/tenant-api/environments/envA/admin/accounts/p1')
        assert.equal(FetchStub.Calls[0]!.init?.method, 'DELETE')
    })

    it('GrantRole POSTs and RevokeRole DELETEs the grants route with the body', async () =>
    {
        const grant = { subject: 'p1', role: 'Admin' }
        const c = new TestClient(new FakeWebSocketFactory())
        FetchStub.Install({ ok: true })
        await c.GrantRole('envA', grant)
        assert.equal(FetchStub.Calls[0]!.route, '/tenant-api/environments/envA/admin/grants')
        assert.equal(FetchStub.Calls[0]!.init?.method, 'POST')
        assert.deepEqual(JSON.parse(FetchStub.Calls[0]!.init?.body as string), grant)
        FetchStub.Install({ ok: true })
        await c.RevokeRole('envA', grant)
        assert.equal(FetchStub.Calls[0]!.route, '/tenant-api/environments/envA/admin/grants')
        assert.equal(FetchStub.Calls[0]!.init?.method, 'DELETE')
        assert.deepEqual(JSON.parse(FetchStub.Calls[0]!.init?.body as string), grant)
    })

    it('DisableAccount maps a 409 to TenantApiError with the backend message', async () =>
    {
        FetchStub.Install({ error: 'cannot disable last owner' }, 409)
        await assert.rejects(new TestClient(new FakeWebSocketFactory()).DisableAccount('envA', 'p1'), (e: unknown) =>
            e instanceof TenantApiError && e.Status === 409 && e.message === 'cannot disable last owner')
    })

    it('encodes the env and principalId path segments', async () =>
    {
        const c = new TestClient(new FakeWebSocketFactory())
        FetchStub.Install({ accounts: [], grants: [] })
        await c.GetAdminSnapshot('env/A b')
        assert.equal(FetchStub.Calls[0]!.route, '/tenant-api/environments/env%2FA%20b/admin/snapshot')
        FetchStub.Install({ ok: true })
        await c.DisableAccount('env/A b', 'u@x/1')
        assert.equal(FetchStub.Calls[0]!.route, '/tenant-api/environments/env%2FA%20b/admin/accounts/u%40x%2F1')
    })
})

describe('TenantApiClient BeginLogin', () =>
{
    it('navigates to the bare begin route', () =>
    {
        const c = new TestClient(new FakeWebSocketFactory())
        c.BeginLogin()
        assert.equal(c.Navigated, '/tenant-auth/oidc/begin')
    })
})

describe('TenantApiClient sockets', () =>
{
    it('OnEvent opens the events path and delivers parsed frames until unsubscribed', () =>
    {
        const sockets = new FakeWebSocketFactory()
        const c = new TestClient(sockets)
        const got: TenantEvent[] = []
        const off = c.OnEvent(ev => { got.push(ev) })
        assert.ok(sockets.Urls[0]!.endsWith('/tenant-api/events'))
        sockets.Sockets[0]!.Push(JSON.stringify({ type: TenantEventType.EnvironmentChanged, environmentName: 'e1' }))
        assert.deepEqual(got, [{ type: TenantEventType.EnvironmentChanged, environmentName: 'e1' }])
        sockets.Sockets[0]!.Push('not json')
        assert.equal(got.length, 1)
        off()
        sockets.Sockets[0]!.Push(JSON.stringify({ type: TenantEventType.HealthChanged, environmentName: 'e2' }))
        assert.equal(got.length, 1)
    })

    it('OnEvent shares one socket across handlers', () =>
    {
        const sockets = new FakeWebSocketFactory()
        const c = new TestClient(sockets)
        c.OnEvent(() => {})
        c.OnEvent(() => {})
        assert.equal(sockets.Sockets.length, 1)
    })

    it('OnEvent drops frames with a bogus type or missing environmentName', () =>
    {
        const sockets = new FakeWebSocketFactory()
        const got: TenantEvent[] = []
        new TestClient(sockets).OnEvent(ev => { got.push(ev) })
        sockets.Sockets[0]!.Push(JSON.stringify({ type: 'bogus', environmentName: 'e1' }))
        sockets.Sockets[0]!.Push(JSON.stringify({ type: TenantEventType.HealthChanged }))
        sockets.Sockets[0]!.Push(JSON.stringify({ type: TenantEventType.HealthChanged, environmentName: '' }))
        assert.equal(got.length, 0)
        sockets.Sockets[0]!.Push(JSON.stringify({ type: TenantEventType.HealthChanged, environmentName: 'e1' }))
        assert.equal(got.length, 1)
    })

    it('OnEvent reconnects after close once the delay elapses', () =>
    {
        mock.timers.enable({ apis: ['setTimeout'] })
        try
        {
            const sockets = new FakeWebSocketFactory()
            new TestClient(sockets).OnEvent(() => {})
            sockets.Sockets[0]!.FireClose()
            assert.equal(sockets.Sockets.length, 1)
            mock.timers.tick(2000)
            assert.equal(sockets.Sockets.length, 2)
            assert.ok(sockets.Urls[1]!.endsWith('/tenant-api/events'))
        }
        finally
        {
            mock.timers.reset()
        }
    })

    it('OnEvent does not reconnect when all handlers unsubscribed', () =>
    {
        mock.timers.enable({ apis: ['setTimeout'] })
        try
        {
            const sockets = new FakeWebSocketFactory()
            const off = new TestClient(sockets).OnEvent(() => {})
            sockets.Sockets[0]!.FireClose()
            off()
            mock.timers.tick(2000)
            assert.equal(sockets.Sockets.length, 1)
        }
        finally
        {
            mock.timers.reset()
        }
    })

    it('OpenLogStream forwards raw chunks and dispose closes the socket', () =>
    {
        const sockets = new FakeWebSocketFactory()
        const c = new TestClient(sockets)
        const chunks: string[] = []
        const dispose = c.OpenLogStream('e 1', t => { chunks.push(t) })
        assert.ok(sockets.Urls[0]!.endsWith('/tenant-api/environments/e%201/logs/stream'))
        sockets.Sockets[0]!.Push('line one\n')
        assert.deepEqual(chunks, ['line one\n'])
        dispose()
        assert.equal(sockets.Sockets[0]!.Closed, true)
    })
})
