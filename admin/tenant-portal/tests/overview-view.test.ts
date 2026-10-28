import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { CreateEnvironmentDialog } from '../src/create-environment-dialog.js'
import { EnvironmentCard } from '../src/environment-card.js'
import { Act, Banner, ScreenState } from '../src/kit/index.js'
import { NavSection } from '../src/nav-model.js'
import { TenantApiError } from '../src/tenant-api-client.js'
import { OverviewView } from '../src/overview-view.js'
import { EnvStatus, EnvType, Template, TenantEventType } from '../src/tenant-types.js'
import type { AdminCapabilitiesDto, CreateEnvironmentParams, EnvironmentDto, HiveHealthDto, HiveRolloutDto, IEnvironmentsSource, IOverviewSource, ITenantNavigator, ManifestDto } from '../src/tenant-types.js'

class Fixtures
{
    private static app: Application | undefined

    public static InitApp(): void
    {
        if (Fixtures.app === undefined)
        {
            Fixtures.app = new Application()
            Fixtures.app.initialize({ theme: Pragmatic, scheme: PragmaticLight })
        }
        Application.current = Fixtures.app
    }

    public static Env(name: string): EnvironmentDto
    {
        return { name, template: Template.DevBlank, type: EnvType.Runtime, environmentId: 'id-' + name, hiveId: 'h1', hostPort: 1, status: EnvStatus.Running, createdAt: '', httpUrl: 'http://' + name, wsUrl: '' }
    }

    public static Collect(v: Visual, out: Visual[] = []): Visual[]
    {
        out.push(v)
        for (const c of v.visualChildren)
        {
            Fixtures.Collect(c, out)
        }
        return out
    }

    public static Texts(v: Visual): string[]
    {
        return Fixtures.Collect(v).map(x => (x as unknown as { Text?: unknown }).Text).filter((t): t is string => typeof t === 'string')
    }

    public static Click(b: Button): void
    {
        for (const h of (b as unknown as { _clickHandlers: Array<(a: unknown) => void> })._clickHandlers)
        {
            h({})
        }
    }
}

class FakeSource implements IOverviewSource, IEnvironmentsSource
{
    public Envs: EnvironmentDto[] = [Fixtures.Env('alpha'), Fixtures.Env('beta')]
    public EnvFailure: Error | undefined
    public Offer = false
    public HealthFailure: Error | undefined

    public async ListEnvironments(): Promise<EnvironmentDto[]>
    {
        if (this.EnvFailure !== undefined)
        {
            throw this.EnvFailure
        }
        return this.Envs
    }
    public async GetHealth(_hiveId: string): Promise<HiveHealthDto[]>
    {
        if (this.HealthFailure !== undefined)
        {
            throw this.HealthFailure
        }
        return []
    }
    public async ListManifests(): Promise<ManifestDto[]>
    {
        const out: ManifestDto[] = [{ id: 'v1', image: 'img:v1', publishedAt: '2026-01-01' }]
        if (this.Offer)
        {
            out.push({ id: 'v2', image: 'img:v2', publishedAt: '2026-02-01' })
        }
        return out
    }
    public async GetRollout(_hiveId: string): Promise<HiveRolloutDto>
    {
        return { targetVersion: 'v1', environments: [{ environmentName: 'alpha', runningImage: 'img:v1', obsolete: false, ready: true }] }
    }
    public async StartEnvironment(name: string): Promise<EnvironmentDto> { return Fixtures.Env(name) }
    public async StopEnvironment(name: string): Promise<EnvironmentDto> { return Fixtures.Env(name) }
    public async RestartEnvironment(name: string): Promise<EnvironmentDto> { return Fixtures.Env(name) }
    public async CreateEnvironment(p: CreateEnvironmentParams): Promise<EnvironmentDto> { return Fixtures.Env(p.name) }
}

class Nav implements ITenantNavigator
{
    public Opened: EnvironmentDto[] = []
    public Sections: unknown[] = []
    public Caps: AdminCapabilitiesDto | undefined

    public LoginCount = 0
    public ShowLogin(): void { this.LoginCount++ }
    public ShowTree(): void {}
    public ShowHiveDetail(): void {}
    public ShowEnvironmentDetail(env: EnvironmentDto): void { this.Opened.push(env) }
    public ShowUsersAccess(): void {}
    public ShowServiceTokens(): void {}
    public ShowSection(section: unknown): void { this.Sections.push(section) }
    public get Profile(): undefined { return undefined }
    public get Capabilities(): AdminCapabilitiesDto | undefined { return this.Caps }
    public get OwnerContact(): undefined { return undefined }
}

class Harness
{
    public static async Make(src = new FakeSource(), caps?: AdminCapabilitiesDto): Promise<{ view: OverviewView; nav: Nav; src: FakeSource }>
    {
        Fixtures.InitApp()
        const view = new OverviewView(src, 'h1')
        const nav = new Nav()
        nav.Caps = caps
        view.AttachNavigator(nav)
        await view.Refresh()
        return { view, nav, src }
    }

    public static Caps(envs: boolean, adopt: boolean): AdminCapabilitiesDto
    {
        return { envs, adopt, access: true, settings: true }
    }
}

describe('OverviewView', () =>
{
    it('renders the title and the Create action', async () =>
    {
        const { view } = await Harness.Make()
        assert.ok(Fixtures.Texts(view).includes(OverviewView.Title))
        assert.ok(Fixtures.Texts(view.CreateAction).includes(OverviewView.CreateLabel))
        assert.equal(view.CreateAction.Enabled, true)
        assert.equal(view.Host.State, ScreenState.Populated)
    })

    it('shows the offer banner only when a newer version is offered', async () =>
    {
        const none = await Harness.Make()
        assert.equal(none.view.OfferBanner, undefined)
        assert.equal(Fixtures.Collect(none.view).some(v => v instanceof Banner), false)
        const src = new FakeSource()
        src.Offer = true
        const { view } = await Harness.Make(src)
        assert.ok(view.OfferBanner instanceof Banner)
        assert.ok(Fixtures.Texts(view).some(t => t.includes(OverviewView.OfferText)))
        assert.ok(Fixtures.Texts(view).some(t => t.includes('v2')))
    })

    it('renders one card per environment row', async () =>
    {
        const { view } = await Harness.Make()
        assert.equal(view.Cards.length, 2)
        assert.equal(Fixtures.Collect(view).filter(v => v instanceof EnvironmentCard).length, 2)
    })

    it('shows the empty state with a Create action when there are no environments', async () =>
    {
        const src = new FakeSource()
        src.Envs = []
        const { view } = await Harness.Make(src)
        assert.equal(view.Host.State, ScreenState.Empty)
        assert.ok(Fixtures.Texts(view.Host).includes(OverviewView.EmptyTitle))
    })

    it('shows the error state when the environments fail to load', async () =>
    {
        const src = new FakeSource()
        src.EnvFailure = new Error('boom')
        const { view } = await Harness.Make(src)
        assert.equal(view.Host.State, ScreenState.Error)
    })

    it('Create opens a single inline CreateEnvironmentDialog', async () =>
    {
        const { view } = await Harness.Make()
        view.CreateAction.Press()
        const first = view.OpenDialog
        assert.ok(first instanceof CreateEnvironmentDialog)
        view.CreateAction.Press()
        assert.equal(view.OpenDialog, first)
        assert.equal(Fixtures.Collect(view).filter(v => v instanceof CreateEnvironmentDialog).length, 1)
        view.Dispose()
        assert.equal(view.OpenDialog, undefined)
    })

    it('Review and adopt navigates to Releases', async () =>
    {
        const src = new FakeSource()
        src.Offer = true
        const { view, nav } = await Harness.Make(src)
        ;(view.ReviewAction as NonNullable<typeof view.ReviewAction>).Press()
        assert.deepEqual(nav.Sections, [NavSection.Releases])
    })

    it('opening a card navigates to the environment detail', async () =>
    {
        const { view, nav } = await Harness.Make()
        const open = Fixtures.Collect(view.Cards[1]).find(v => v instanceof Button) as Button
        Fixtures.Click(open)
        assert.equal(nav.Opened.length, 1)
        assert.equal(nav.Opened[0].name, 'beta')
    })

    it('gates Create on envs and Review on adopt, naming the permission', async () =>
    {
        const src = new FakeSource()
        src.Offer = true
        const denied = await Harness.Make(src, Harness.Caps(false, false))
        assert.equal(denied.view.CreateAction.Enabled, false)
        assert.ok(denied.view.CreateAction.DisabledHint?.includes(OverviewView.NeedManage))
        const review = denied.view.ReviewAction as NonNullable<typeof denied.view.ReviewAction>
        assert.equal(review.Enabled, false)
        assert.ok(review.DisabledHint?.includes(OverviewView.NeedAdopt))
        const allowed = await Harness.Make(src, Harness.Caps(true, true))
        assert.equal(allowed.view.CreateAction.Enabled, true)
        assert.equal(allowed.view.ReviewAction?.Enabled, true)
    })

    it('ApplyEvent reloads the environments', async () =>
    {
        const { view, src } = await Harness.Make()
        src.Envs = [Fixtures.Env('alpha'), Fixtures.Env('beta'), Fixtures.Env('gamma')]
        await view.ApplyEvent({ type: TenantEventType.EnvironmentCreated, environmentName: 'gamma' })
        assert.equal(view.Cards.length, 3)
    })

    it('a 401 on a read drops to login instead of rendering the home', async () =>
    {
        const src = new FakeSource()
        src.HealthFailure = new TenantApiError(401, 'x')
        const { view, nav } = await Harness.Make(src)
        assert.equal(nav.LoginCount, 1)
        assert.notEqual(view.Host.State, ScreenState.Populated)
    })

    it('a non-401 refresh failure shows the error state', async () =>
    {
        const src = new FakeSource()
        src.EnvFailure = new TenantApiError(500, 'down')
        const { view, nav } = await Harness.Make(src)
        assert.equal(nav.LoginCount, 0)
        assert.equal(view.Host.State, ScreenState.Error)
    })

    it('renders the loading state before the first refresh', () =>
    {
        Fixtures.InitApp()
        const view = new OverviewView(new FakeSource(), 'h1')
        assert.equal(view.Host.State, ScreenState.Loading)
    })

    it('a dismissed create dialog can be reopened', async () =>
    {
        const { view } = await Harness.Make()
        view.CreateAction.Press()
        const first = view.OpenDialog as CreateEnvironmentDialog
        first.Cancel()
        assert.equal(view.OpenDialog, undefined)
        view.CreateAction.Press()
        const second: unknown = view.OpenDialog
        assert.ok(second instanceof CreateEnvironmentDialog)
        assert.notEqual(second, first)
    })

    it('a created environment opens its detail', async () =>
    {
        const { view, nav } = await Harness.Make()
        view.CreateAction.Press()
        const dialog = view.OpenDialog as CreateEnvironmentDialog
        dialog.SetName('gamma')
        await dialog.Submit()
        assert.equal(nav.Opened.length, 1)
        assert.equal(nav.Opened[0].name, 'gamma')
        assert.equal(view.OpenDialog, undefined)
    })

    it('the empty-state Create opens a dialog that is visible in the view tree', async () =>
    {
        const src = new FakeSource()
        src.Envs = []
        const { view } = await Harness.Make(src)
        assert.equal(view.Host.State, ScreenState.Empty)
        const act = Fixtures.Collect(view.Host).find(v => v instanceof Act) as Act
        act.Press()
        assert.ok(view.OpenDialog instanceof CreateEnvironmentDialog)
        assert.equal(Fixtures.Collect(view).filter(v => v instanceof CreateEnvironmentDialog).length, 1)
    })
})
