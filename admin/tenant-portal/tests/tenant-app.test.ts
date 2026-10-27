import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { StackPanel } from '@pragmatic-tech-ai/mural/basic'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { TenantApp } from '../src/tenant-app.js'
import { TenantApiError } from '../src/tenant-api-client.js'
import { UsersAccessView } from '../src/users-access-view.js'
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

    public BeginLogin(...args: unknown[]): void
    {
        this.Calls.push('login:' + args.length)
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

    public async ListEnvironments(): Promise<EnvironmentDto[]>
    {
        return []
    }

    public OpenLogStream(): () => void
    {
        return () => {}
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

    public static Make(session: SessionDto | null | TenantApiError): { app: TenantApp; client: FakeClient }
    {
        const client = new FakeClient(session)
        return { app: new TenantApp(client as unknown as TenantApiClient), client }
    }
}

const Session: SessionDto = { tenantId: 't1', principalId: 'p', email: 'me@x.io' }

describe('TenantApp', () =>
{
    it('boot with a session subscribes once and shows the tenant name', async () =>
    {
        const { app, client } = Fixtures.Make(Session)
        await app.Boot()
        assert.equal(client.Calls.filter(c => c === 'onevent').length, 1)
        assert.ok(Fixtures.Texts(app).includes('me@x.io'))
        assert.ok(Fixtures.Texts(app).includes(TenantApp.EmptySelectionText))
        assert.ok(!client.Calls.some(c => c.startsWith('login')))
    })

    it('swaps the detail pane back to the placeholder when the open environment is deleted', async () =>
    {
        const { app, client } = Fixtures.Make(Session)
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

    it('null session begins login with no tenant argument', async () =>
    {
        const { app, client } = Fixtures.Make(null)
        await app.Boot()
        assert.deepEqual(client.Calls, ['login:0'])
    })

    it('a 401 from Session falls back to login', async () =>
    {
        const { app, client } = Fixtures.Make(new TenantApiError(401, 'no'))
        await app.Boot()
        assert.deepEqual(client.Calls, ['login:0'])
    })

    it('logout calls client.Logout, tears down the subscription, returns to login', async () =>
    {
        const { app, client } = Fixtures.Make(Session)
        await app.Boot()
        const btn = Fixtures.Find(app, Button, b => Fixtures.Texts(b).includes(TenantApp.LogoutLabel))!
        Fixtures.Click(btn)
        await new Promise(r => setTimeout(r, 0))
        assert.deepEqual(client.Calls, ['onevent', 'logout', 'login:0'])
        assert.equal(client.UnsubCalls, 1)
    })

    it('Show disposes the outgoing view exactly once; logout disposes the current view', async () =>
    {
        const { app, client } = Fixtures.Make(Session)
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

    it('Boot records the operator principalId from the session', async () =>
    {
        const { app } = Fixtures.Make(Session)
        await app.Boot()
        assert.equal(app.CurrentPrincipalId, Session.principalId)
    })

    it('the Users & Access top-bar button shows the UsersAccessView', async () =>
    {
        const { app } = Fixtures.Make(Session)
        await app.Boot()
        const label = (TenantApp as unknown as { UsersAccessLabel: string }).UsersAccessLabel
        const btn = Fixtures.Find(app, Button, b => Fixtures.Texts(b).includes(label))
        assert.ok(btn, 'Users & Access button exists')
        Fixtures.Click(btn)
        await new Promise(r => setTimeout(r, 0))
        const current = (app as unknown as { current: unknown }).current
        assert.ok(current instanceof UsersAccessView)
    })

    it('a second Boot does not stack event subscriptions', async () =>
    {
        const { app, client } = Fixtures.Make(Session)
        await app.Boot()
        await app.Boot()
        assert.equal(client.UnsubCalls, 1)
        assert.equal(client.Calls.filter(c => c === 'onevent').length, 2)
    })
})
