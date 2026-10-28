import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { StackPanel } from '@pragmatic-tech-ai/mural/basic'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { TenantApp } from '../src/tenant-app.js'
import { TenantApiError } from '../src/tenant-api-client.js'
import type { TenantApiClient } from '../src/tenant-api-client.js'
import { EnvStatus, EnvType, Template, TenantEventType } from '../src/tenant-types.js'
import type { HiveRolloutDto, ManifestDto, EnvironmentDto, TenantProfileDto, HiveDto, HiveHealthDto, ITenantNavigator, ITenantView, ServiceTokenSummaryDto, SessionDto, TenantEvent } from '../src/tenant-types.js'
import { ServiceTokensView } from '../src/service-tokens-view.js'
import { UsersAccessPageView } from '../src/users-access-page-view.js'
import { EnvironmentDetailView } from '../src/environment-detail-view.js'
import { SettingsView } from '../src/settings-view.js'
import { EnvironmentsView } from '../src/environments-view.js'
import { CreateEnvironmentDialog } from '../src/create-environment-dialog.js'
import { ReleasesView } from '../src/releases-view.js'
import { OverviewView } from '../src/overview-view.js'
import { NavRail } from '../src/nav-rail.js'
import { NavModel, NavSection } from '../src/nav-model.js'
import { UserMenu } from '../src/user-menu.js'
import { TopBar } from '../src/top-bar.js'

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

    public ProfileResult: TenantProfileDto | Error | undefined

    public async Profile(): Promise<TenantProfileDto>
    {
        if (this.ProfileResult === undefined || this.ProfileResult instanceof Error)
        {
            throw this.ProfileResult ?? new Error('no profile')
        }
        return this.ProfileResult
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

    public Existing: EnvironmentDto[] = []

    public async ListEnvironments(): Promise<EnvironmentDto[]>
    {
        this.Calls.push('list')
        return this.Existing
    }

    public async CreateEnvironment(p: { name: string; template: Template; type: EnvType }): Promise<EnvironmentDto>
    {
        return { name: p.name, template: p.template, type: p.type, environmentId: p.name, hiveId: 'h1', hostPort: 9000, status: EnvStatus.Running, createdAt: '', httpUrl: '', wsUrl: '' }
    }

    public async ListManifests(): Promise<ManifestDto[]>
    {
        return []
    }

    public async GetRollout(): Promise<HiveRolloutDto>
    {
        return { targetVersion: undefined, environments: [] }
    }

    public async ListHives(): Promise<HiveDto[]>
    {
        return [{ id: 'h1', tenantId: 't1', displayName: 'H', cluster: { backend: 'b', mode: 'm' }, registry: { mode: 'r' }, createdAt: '' }]
    }

    public async ListTokens(): Promise<ServiceTokenSummaryDto[]>
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

    public static CurrentOf(app: TenantApp): unknown
    {
        return (app as unknown as { current: unknown }).current
    }

    public static Click(b: Button): void
    {
        const hs = (b as unknown as { _clickHandlers: Array<(a: unknown) => void> })._clickHandlers
        for (const h of hs) h({})
    }

    public static Make(session: SessionDto | null | TenantApiError, profile?: TenantProfileDto | Error): { app: TenantApp; client: FakeClient }
    {
        const client = new FakeClient(session)
        client.ProfileResult = profile
        return { app: new TenantApp(client as unknown as TenantApiClient), client }
    }
}

const Session: SessionDto = { tenantId: 't1', principalId: 'p', email: 'me@x.io' }

describe('TenantApp', () =>
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

    it('boot with a session subscribes once and shows the tenant name', async () =>
    {
        const { app, client } = Fixtures.Make(Session)
        await app.Boot()
        assert.equal(client.Calls.filter(c => c === 'onevent').length, 1)
        assert.ok(Fixtures.Texts(app).includes('me@x.io'))
        await new Promise(r => setTimeout(r, 0))
        assert.ok(Fixtures.CurrentOf(app) instanceof OverviewView, 'Overview landing shown, not a placeholder')
        assert.ok(!client.Calls.some(c => c.startsWith('login')))
    })

    it('falls back to the environments list when the open environment is deleted', async () =>
    {
        const { app, client } = Fixtures.Make(Session)
        await app.Boot()
        const env: EnvironmentDto = { name: 'e1', template: Template.DevBlank, type: EnvType.Development, environmentId: 'e1', hiveId: 'h1', hostPort: 9000, status: EnvStatus.Running, createdAt: '', httpUrl: '', wsUrl: '' }
        app.ShowEnvironmentDetail(env)
        await new Promise(r => setTimeout(r, 0))
        const detail = Fixtures.CurrentOf(app)
        assert.ok(detail instanceof EnvironmentDetailView)
        // A delete of a different env does not swap the pane.
        client.Handler!({ type: TenantEventType.EnvironmentDeleted, environmentName: 'other' })
        await new Promise(r => setTimeout(r, 0))
        assert.equal(Fixtures.CurrentOf(app), detail, 'unrelated delete left the pane')
        // A delete of the open env swaps back to the environments list.
        client.Handler!({ type: TenantEventType.EnvironmentDeleted, environmentName: 'e1' })
        await new Promise(r => setTimeout(r, 0))
        assert.ok(Fixtures.CurrentOf(app) instanceof EnvironmentsView)
        assert.equal(app.ActiveSection, NavSection.Environments)
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

    it('boot with a profile wires plate, role label and live navigator getters', async () =>
    {
        const profile: TenantProfileDto = {
            principalId: 'p',
            email: 'owner@nw.io',
            roleLabel: 'Tenant owner',
            tenant: { id: 't1', displayName: 'Northwind Production', organisation: 'Northwind Group' },
            hive: { id: 'h1', displayName: 'hv-nw-eu1' },
            capabilities: { envs: true, adopt: true, access: true, settings: true }
        }
        const { app } = Fixtures.Make(Session, profile)
        await app.Boot()
        const texts = Fixtures.Texts(app)
        for (const t of ['Northwind Group', 'Northwind Production', 'hv-nw-eu1', 'Tenant owner', 'owner@nw.io'])
        {
            assert.ok(texts.includes(t), t)
        }
        assert.deepEqual(app.Capabilities, profile.capabilities)
        assert.equal(app.Profile, profile)
    })

    it('boot with a profile lacking a hive shows the tenant name and the hive placeholder', async () =>
    {
        const profile: TenantProfileDto = {
            principalId: 'p',
            roleLabel: 'Tenant owner',
            tenant: { id: 't1', displayName: 'Northwind Production' },
            capabilities: { envs: true, adopt: true, access: true, settings: true }
        }
        const { app } = Fixtures.Make(Session, profile)
        await app.Boot()
        const texts = Fixtures.Texts(app)
        assert.ok(texts.includes('Northwind Production'))
        assert.ok(texts.includes(TenantApp.HivePlaceholder))
        assert.ok(!texts.includes(Session.tenantId))
    })

    it('boot falls back permissively when the profile read fails', async () =>
    {
        const { app, client } = Fixtures.Make(Session, new Error('boom'))
        await app.Boot()
        const texts = Fixtures.Texts(app)
        assert.ok(texts.includes(Session.tenantId))
        assert.ok(texts.includes(TenantApp.HivePlaceholder))
        assert.ok(!texts.includes('Tenant owner'))
        assert.equal(app.Capabilities, undefined)
        assert.equal(app.Profile, undefined)
        assert.deepEqual(client.Calls, ['onevent', 'list'])
    })

    it('logout calls client.Logout, tears down the subscription, returns to login', async () =>
    {
        const { app, client } = Fixtures.Make(Session)
        await app.Boot()
        const btn = Fixtures.Find(app, Button, b => Fixtures.Texts(b).includes(UserMenu.LogoutLabel))!
        Fixtures.Click(btn)
        await new Promise(r => setTimeout(r, 0))
        assert.deepEqual(client.Calls, ['onevent', 'list', 'logout', 'login:0'])
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
        Fixtures.Click(Fixtures.Find(app, Button, x => Fixtures.Texts(x).includes(UserMenu.LogoutLabel))!)
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

    it('the nav rail has six items', async () =>
    {
        const { app } = Fixtures.Make(Session)
        await app.Boot()
        const rail = Fixtures.Find(app, NavRail)!
        assert.equal(NavModel.Items.length, 6)
        for (const item of NavModel.Items)
        {
            assert.ok(Fixtures.Texts(rail).includes(item.Label), item.Label)
        }
        assert.equal(rail.Active, NavSection.Overview)
    })

    it('ShowSection(UsersAccess) shows the page', async () =>
    {
        const { app } = Fixtures.Make(Session)
        await app.Boot()
        app.ShowSection(NavSection.UsersAccess)
        await new Promise(r => setTimeout(r, 0))
        assert.ok(Fixtures.CurrentOf(app) instanceof UsersAccessPageView)
        assert.equal(Fixtures.Find(app, NavRail)!.Active, NavSection.UsersAccess)
    })

    it('ShowSection(Environments) shows the environments list and marks Environments active', async () =>
    {
        const { app } = Fixtures.Make(Session)
        await app.Boot()
        Fixtures.Find(app, NavRail)!.Select(NavSection.Environments)
        await new Promise(r => setTimeout(r, 0))
        assert.ok(Fixtures.CurrentOf(app) instanceof EnvironmentsView)
        assert.equal(Fixtures.Find(app, NavRail)!.Active, NavSection.Environments)
    })

    it('ShowSection(Settings) shows the read-only SettingsView', async () =>
    {
        const { app } = Fixtures.Make(Session)
        await app.Boot()
        app.ShowSection(NavSection.Settings)
        const view = Fixtures.CurrentOf(app)
        assert.ok(view instanceof SettingsView)
        assert.ok(Fixtures.Texts(view).includes('Settings'))
    })

    it('ShowSection(Overview) shows the OverviewView, not a placeholder', async () =>
    {
        const { app } = Fixtures.Make(Session)
        await app.Boot()
        app.ShowSection(NavSection.Environments)
        Fixtures.Find(app, NavRail)!.Select(NavSection.Overview)
        await new Promise(r => setTimeout(r, 0))
        assert.ok(Fixtures.CurrentOf(app) instanceof OverviewView)
        assert.equal(Fixtures.Find(app, NavRail)!.Active, NavSection.Overview)
    })

    it('ShowSection(Releases) shows the ReleasesView, not a placeholder', async () =>
    {
        const { app } = Fixtures.Make(Session)
        await app.Boot()
        Fixtures.Find(app, NavRail)!.Select(NavSection.Releases)
        await new Promise(r => setTimeout(r, 0))
        assert.ok(Fixtures.CurrentOf(app) instanceof ReleasesView)
        assert.equal(Fixtures.Find(app, NavRail)!.Active, NavSection.Releases)
    })

    it('showing an environment or hive detail keeps Environments active', async () =>
    {
        const { app } = Fixtures.Make(Session)
        await app.Boot()
        const env: EnvironmentDto = { name: 'e1', template: Template.DevBlank, type: EnvType.Development, environmentId: 'e1', hiveId: 'h1', hostPort: 9000, status: EnvStatus.Running, createdAt: '', httpUrl: '', wsUrl: '' }
        app.ShowEnvironmentDetail(env)
        assert.equal(Fixtures.Find(app, NavRail)!.Active, NavSection.Environments)
        app.ShowSection(NavSection.Settings)
        const hive: HiveDto = { id: 'h1', tenantId: 't1', displayName: 'H', cluster: { backend: 'b', mode: 'm' }, registry: { mode: 'r' }, createdAt: '' }
        app.ShowHiveDetail(hive)
        assert.equal(Fixtures.Find(app, NavRail)!.Active, NavSection.Environments)
    })

    it('the old top-bar command buttons are gone', async () =>
    {
        const { app } = Fixtures.Make(Session)
        await app.Boot()
        app.ShowSection(NavSection.Overview)
        const texts = Fixtures.Texts(app)
        for (const label of ['Service Tokens', 'Roles & Privileges', 'Field Security'])
        {
            assert.ok(!texts.includes(label), label)
        }
        // 'Users & Access' appears only once: the nav rail row, no top-bar button.
        assert.equal(texts.filter(t => t === 'Users & Access').length, 1)
    })

    it('the token navigator method still shows its view', async () =>
    {
        const { app } = Fixtures.Make(Session)
        await app.Boot()
        app.ShowServiceTokens()
        assert.ok(Fixtures.CurrentOf(app) instanceof ServiceTokensView)
    })

    it('OnTenantEvent and Teardown do not throw with no environments pane', async () =>
    {
        const { app, client } = Fixtures.Make(Session)
        await app.Boot()
        assert.doesNotThrow(() => client.Handler!({ type: TenantEventType.EnvironmentChanged, environmentName: 'x' }))
        app.ShowLogin()
        assert.doesNotThrow(() => client.Handler!({ type: TenantEventType.EnvironmentChanged, environmentName: 'x' }))
        assert.doesNotThrow(() => app.ShowLogin())
    })

    it('an event with the environments list active takes a single refresh path', async () =>
    {
        const { app, client } = Fixtures.Make(Session)
        await app.Boot()
        app.ShowSection(NavSection.Environments)
        await new Promise(r => setTimeout(r, 0))
        const list = Fixtures.CurrentOf(app) as EnvironmentsView
        let applied = 0
        let refreshed = 0
        list.ApplyEvent = async () => { applied++ }
        list.Refresh = async () => { refreshed++ }
        client.Handler!({ type: TenantEventType.EnvironmentChanged, environmentName: 'x' })
        assert.equal(applied, 1)
        assert.equal(refreshed, 0)
    })

    it('an environment-created event reloads the shown environments list', async () =>
    {
        const { app, client } = Fixtures.Make(Session)
        await app.Boot()
        app.ShowSection(NavSection.Environments)
        await new Promise(r => setTimeout(r, 0))
        const before = client.Calls.filter(c => c === 'list').length
        client.Handler!({ type: TenantEventType.EnvironmentCreated, environmentName: 'new' })
        await new Promise(r => setTimeout(r, 0))
        assert.ok(client.Calls.filter(c => c === 'list').length > before)
    })

    it('the create handler presents the dialog and removing it on dismiss works', async () =>
    {
        const { app } = Fixtures.Make(Session)
        await app.Boot()
        app.ShowSection(NavSection.Environments)
        await new Promise(r => setTimeout(r, 0))
        const list = Fixtures.CurrentOf(app) as EnvironmentsView
        list.CreateHandler()
        const dialog = Fixtures.Find(app, CreateEnvironmentDialog)
        assert.ok(dialog !== undefined)
        dialog.Cancel()
        assert.equal(Fixtures.Find(app, CreateEnvironmentDialog), undefined)
    })

    it('a successful create navigates to the new environment detail, rejects existing names', async () =>
    {
        const { app, client } = Fixtures.Make(Session)
        client.Existing = [{ name: 'taken', template: Template.DevBlank, type: EnvType.Development, environmentId: 'taken', hiveId: 'h1', hostPort: 9001, status: EnvStatus.Running, createdAt: '', httpUrl: '', wsUrl: '' }]
        await app.Boot()
        app.ShowSection(NavSection.Environments)
        await new Promise(r => setTimeout(r, 0))
        ;(Fixtures.CurrentOf(app) as EnvironmentsView).CreateHandler()
        const dialog = Fixtures.Find(app, CreateEnvironmentDialog)!
        dialog.SetName('taken')
        assert.equal(dialog.CreateEnabled, false, 'existing name rejected')
        dialog.SetName('fresh')
        await dialog.Submit()
        await new Promise(r => setTimeout(r, 0))
        const detail = Fixtures.CurrentOf(app)
        assert.ok(detail instanceof EnvironmentDetailView)
        assert.equal(app.ActiveSection, NavSection.Environments)
        assert.equal(Fixtures.Find(app, CreateEnvironmentDialog), undefined)
    })

    it('changing the shown view dismisses an open create dialog', async () =>
    {
        const { app } = Fixtures.Make(Session)
        await app.Boot()
        app.ShowSection(NavSection.Environments)
        await new Promise(r => setTimeout(r, 0))
        ;(Fixtures.CurrentOf(app) as EnvironmentsView).CreateHandler()
        assert.ok(Fixtures.Find(app, CreateEnvironmentDialog) !== undefined)
        app.ShowSection(NavSection.Settings)
        assert.equal(Fixtures.Find(app, CreateEnvironmentDialog), undefined)
    })

    it('the shell no longer references the retired tree', async () =>
    {
        const src = readFileSync(new URL('../src/tenant-app.ts', import.meta.url), 'utf8')
        assert.ok(!src.includes('TenantTree'))
    })

    it('logout clears the stored principalId', async () =>
    {
        const { app } = Fixtures.Make(Session)
        await app.Boot()
        assert.equal(app.CurrentPrincipalId, Session.principalId)
        Fixtures.Click(Fixtures.Find(app, Button, x => Fixtures.Texts(x).includes(UserMenu.LogoutLabel))!)
        await new Promise(r => setTimeout(r, 0))
        assert.equal(app.CurrentPrincipalId, '')
    })

    it('a second Boot does not stack event subscriptions', async () =>
    {
        const { app, client } = Fixtures.Make(Session)
        await app.Boot()
        await app.Boot()
        assert.equal(client.UnsubCalls, 1)
        assert.equal(client.Calls.filter(c => c === 'onevent').length, 2)
    })

    it('an observed event is recorded in the activity log and reflected in the drawer list', async () =>
    {
        const { app, client } = Fixtures.Make(Session)
        await app.Boot()
        const before = app.Activity.Entries.length
        client.Handler!({ type: TenantEventType.EnvironmentChanged, environmentName: 'x' })
        assert.equal(app.Activity.Entries.length, before + 1)
        assert.equal(app.ActivityListControl.Rows.length, app.Activity.Entries.length)
        assert.equal(app.ActivityListControl.IsEmpty, false)
    })

    it('OpenActivityDrawer opens the drawer, which starts closed', async () =>
    {
        const { app } = Fixtures.Make(Session)
        await app.Boot()
        assert.equal(app.ActivityDrawer.Open, false)
        app.OpenActivityDrawer()
        assert.equal(app.ActivityDrawer.Open, true)
    })

    it('recording while a non-environments section is shown still updates the drawer', async () =>
    {
        const { app, client } = Fixtures.Make(Session)
        await app.Boot()
        app.ShowSection(NavSection.Settings)
        client.Handler!({ type: TenantEventType.EnvironmentChanged, environmentName: 'y' })
        assert.equal(app.Activity.Count, 1)
        assert.equal(app.ActivityListControl.Rows.length, 1)
    })

    it('the top-bar activity count tracks Activity.Count and the toggle toggles the drawer', async () =>
    {
        const { app, client } = Fixtures.Make(Session)
        await app.Boot()
        const bar = Fixtures.Find(app, TopBar)!
        assert.equal(bar.ActivityCountText, '0')
        client.Handler!({ type: TenantEventType.EnvironmentChanged, environmentName: 'x' })
        assert.equal(bar.ActivityCountText, String(app.Activity.Count))
        bar.ActivityToggle.Press()
        assert.equal(app.ActivityDrawer.Open, true)
        bar.ActivityToggle.Press()
        assert.equal(app.ActivityDrawer.Open, false)
    })

    it('Teardown disposes the log subscription', async () =>
    {
        const { app, client } = Fixtures.Make(Session)
        await app.Boot()
        app.ShowLogin()
        client.Handler!({ type: TenantEventType.EnvironmentChanged, environmentName: 'x' })
        assert.equal(app.ActivityListControl.Rows.length, 0)
    })
})
