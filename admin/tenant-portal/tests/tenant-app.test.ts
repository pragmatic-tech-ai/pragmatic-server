import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { StackPanel, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { TenantApp } from '../src/tenant-app.js'
import type { ITenantEnvironment } from '../src/tenant-app.js'
import { TenantApiError } from '../src/tenant-api-client.js'
import type { TenantApiClient } from '../src/tenant-api-client.js'
import { TenantEventType } from '../src/tenant-types.js'
import type { EnvironmentDto, HiveDto, HiveHealthDto, ITenantNavigator, ITenantView, SessionDto, TenantEvent } from '../src/tenant-types.js'

class FakeClient
{
    public Calls: string[] = []
    public UnsubCalls = 0
    public Handler: ((ev: TenantEvent) => void) | undefined

    public constructor(private readonly session: SessionDto | null | TenantApiError)
    {
    }

    public async Session(): Promise<SessionDto | null>
    {
        if (this.session instanceof TenantApiError)
        {
            throw this.session
        }
        return this.session
    }

    public BeginLogin(tenantId: string): void
    {
        this.Calls.push('login:' + tenantId)
    }

    public async Logout(): Promise<void>
    {
        this.Calls.push('logout')
    }

    public OnEvent(h: (ev: TenantEvent) => void): () => void
    {
        this.Calls.push('onevent')
        this.Handler = h
        return () => { this.UnsubCalls++ }
    }

    // Minimal surface so a real EnvironmentDetailView mounts without a backend.
    public async GetHealth(): Promise<HiveHealthDto[]>
    {
        return []
    }

    public OpenLogStream(): () => void
    {
        return () => {}
    }
}

class StubEnvironment implements ITenantEnvironment
{
    public Stored: string | null

    public constructor(private readonly query: string | null, stored: string | null = null)
    {
        this.Stored = stored
    }

    public QueryTenant(): string | null
    {
        return this.query
    }

    public StoredTenant(): string | null
    {
        return this.Stored
    }

    public StoreTenant(id: string): void
    {
        this.Stored = id
    }
}

class DisposableView extends StackPanel implements ITenantView
{
    public Disposed = 0

    public AttachNavigator(_nav: ITenantNavigator): void
    {
    }

    public Refresh(): void
    {
    }

    public Dispose(): void
    {
        this.Disposed++
    }
}

class Fixtures
{
    public static Texts(node: unknown): string[]
    {
        const n = node as { Text?: unknown; Children?: Iterable<unknown>; Content?: unknown }
        const out: string[] = []
        if (typeof n.Text === 'string')
        {
            out.push(n.Text)
        }
        if (n.Content !== undefined && n.Content !== null)
        {
            out.push(...Fixtures.Texts(n.Content))
        }
        if (n.Children !== undefined)
        {
            for (const c of n.Children)
            {
                out.push(...Fixtures.Texts(c))
            }
        }
        return out
    }

    public static Find<T>(node: unknown, ctor: new (...a: never[]) => T, pred: (x: T) => boolean = () => true): T | undefined
    {
        if (node instanceof ctor && pred(node))
        {
            return node
        }
        const n = node as { Children?: Iterable<unknown>; Content?: unknown }
        const kids: unknown[] = n.Children !== undefined ? [...n.Children] : []
        for (const c of kids)
        {
            const r = Fixtures.Find(c, ctor, pred)
            if (r !== undefined) return r
        }
        return undefined
    }

    public static Click(b: Button): void
    {
        const hs = (b as unknown as { _clickHandlers: Array<(a: unknown) => void> })._clickHandlers
        for (const h of hs) h({})
    }

    public static Make(session: SessionDto | null | TenantApiError, env: StubEnvironment): { app: TenantApp; client: FakeClient }
    {
        const client = new FakeClient(session)
        return { app: new TenantApp(client as unknown as TenantApiClient, env), client }
    }
}

const Session: SessionDto = { tenantId: 't1', principalId: 'p', email: 'me@x.io' }

describe('TenantApp', () =>
{
    it('boot with a session subscribes once and shows the tenant name', async () =>
    {
        const { app, client } = Fixtures.Make(Session, new StubEnvironment(null))
        await app.Boot()
        assert.equal(client.Calls.filter(c => c === 'onevent').length, 1)
        assert.ok(Fixtures.Texts(app).includes('me@x.io'))
        assert.ok(Fixtures.Texts(app).includes(TenantApp.EmptySelectionText))
        assert.ok(!client.Calls.some(c => c.startsWith('login')))
    })

    it('swaps the detail pane back to the placeholder when the open environment is deleted', async () =>
    {
        const { app, client } = Fixtures.Make(Session, new StubEnvironment(null))
        await app.Boot()
        const env: EnvironmentDto = { name: 'e1', template: 't', type: 'development', environmentId: 'e1', hiveId: 'h1', hostPort: 9000, status: 'running', createdAt: '', httpUrl: '', wsUrl: '' }
        app.ShowEnvironmentDetail(env)
        await new Promise(r => setTimeout(r, 0))
        assert.ok(!Fixtures.Texts(app).includes(TenantApp.EmptySelectionText), 'detail pane replaced the placeholder')
        // A delete of a different env does not swap the pane.
        client.Handler!({ type: TenantEventType.EnvironmentDeleted, environmentName: 'other' })
        await new Promise(r => setTimeout(r, 0))
        assert.ok(!Fixtures.Texts(app).includes(TenantApp.EmptySelectionText), 'unrelated delete left the pane')
        // A delete of the open env swaps back to the placeholder.
        client.Handler!({ type: TenantEventType.EnvironmentDeleted, environmentName: 'e1' })
        await new Promise(r => setTimeout(r, 0))
        assert.ok(Fixtures.Texts(app).includes(TenantApp.EmptySelectionText), 'placeholder restored after the open env was deleted')
    })

    it('null session begins login with the query tenant and persists it', async () =>
    {
        const env = new StubEnvironment('acme')
        const { app, client } = Fixtures.Make(null, env)
        await app.Boot()
        assert.deepEqual(client.Calls, ['login:acme'])
        assert.equal(env.Stored, 'acme')
    })

    it('a 401 from Session falls back to login using stored tenant', async () =>
    {
        const { app, client } = Fixtures.Make(new TenantApiError(401, 'no'), new StubEnvironment(null, 'stored'))
        await app.Boot()
        assert.deepEqual(client.Calls, ['login:stored'])
    })

    it('no tenant id anywhere renders the prompt, Continue begins login', async () =>
    {
        const { app, client } = Fixtures.Make(null, new StubEnvironment(null))
        await app.Boot()
        assert.ok(Fixtures.Texts(app).includes(TenantApp.PromptText))
        assert.deepEqual(client.Calls, [])
        const box = Fixtures.Find(app, TextBox)!
        box.Text = 'zed'
        const btn = Fixtures.Find(app, Button, b => Fixtures.Texts(b).includes(TenantApp.ContinueLabel))!
        Fixtures.Click(btn)
        assert.deepEqual(client.Calls, ['login:zed'])
    })

    it('logout calls client.Logout, tears down the subscription, returns to login', async () =>
    {
        const { app, client } = Fixtures.Make(Session, new StubEnvironment('acme'))
        await app.Boot()
        const btn = Fixtures.Find(app, Button, b => Fixtures.Texts(b).includes(TenantApp.LogoutLabel))!
        Fixtures.Click(btn)
        await new Promise(r => setTimeout(r, 0))
        assert.deepEqual(client.Calls, ['onevent', 'logout', 'login:acme'])
        assert.equal(client.UnsubCalls, 1)
    })

    it('Show disposes the outgoing view exactly once; logout disposes the current view', async () =>
    {
        const { app, client } = Fixtures.Make(Session, new StubEnvironment('acme'))
        await app.Boot()
        const a = new DisposableView()
        const b = new DisposableView()
        const show = (app as unknown as { Show(v: ITenantView): void }).Show.bind(app)
        show(a)
        show(b)
        assert.equal(a.Disposed, 1)
        assert.equal(b.Disposed, 0)
        Fixtures.Click(Fixtures.Find(app, Button, x => Fixtures.Texts(x).includes(TenantApp.LogoutLabel))!)
        await new Promise(r => setTimeout(r, 0))
        assert.equal(b.Disposed, 1)
        assert.equal(a.Disposed, 1)
        assert.equal(client.UnsubCalls, 1)
    })

    it('a second Boot does not stack event subscriptions', async () =>
    {
        const { app, client } = Fixtures.Make(Session, new StubEnvironment(null))
        await app.Boot()
        await app.Boot()
        assert.equal(client.UnsubCalls, 1)
        assert.equal(client.Calls.filter(c => c === 'onevent').length, 2)
    })
})
