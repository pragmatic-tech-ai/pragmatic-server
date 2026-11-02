import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { ApplicationService, ServiceKey, ServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { NavigationDestination } from '@pragmatic-tech-ai/mural/framework/shell/services/navigation-service.js'
import { Capability } from '@pragmatic-tech-ai/mural/framework/shell/module.js'
import { TenantApiError } from '../../tenant-api-client.js'
import { TenantEventType } from '../../tenant-types.js'
import { AdminCapability } from '../admin-capability.js'
import { ConfirmDialogViewModel } from '../confirm-dialog-view-model.js'
import { LiveUpdateBridge } from '../live-update-bridge.js'
import { LoginPageViewModel } from '../login-page-view-model.js'
import { NameConfirmDialogViewModel } from '../name-confirm-dialog-view-model.js'
import { ShownPage, type IShownPage } from '../shown-page.js'
import { BootTarget, TenantBoot } from '../tenant-boot.js'
import { TenantNavigationService } from '../tenant-navigation-service.js'
import { PageState, TenantPageViewModel } from '../tenant-page-view-model.js'
import { TenantSectionService } from '../tenant-section-service.js'
import type { TenantSessionService } from '../tenant-session-service.js'
import { FakeReloader, FakeTenantApi, TenantTestHost, TestRail, Tick, type FakeDialogService } from './tenant-test-fixtures.js'

// A page whose load is scripted per test.
class StubPage extends TenantPageViewModel implements IShownPage
{
    public Loads = 0
    public Shown = 0
    public Hidden = 0
    public Next: () => Promise<boolean> = async () => true
    public readonly Act

    public constructor(session: TenantSessionService, public readonly Name: string)
    {
        super(session)
        ShownPage.Register(this)
        this.Act = this.MutatingCommand(AdminCapability.Environments, async () => { this.Acted++ })
    }

    public Acted = 0

    public OnShown(): void
    {
        this.Shown++
    }

    public OnHidden(): void
    {
        this.Hidden++
    }

    public RunConfirm(dialogs: FakeDialogService, action: () => Promise<void>): Promise<void>
    {
        return this.Guard(() => this.Confirm(dialogs, {
            Capability: AdminCapability.Environments, Title: 'Stop?', Message: 'Stops it.', ConfirmLabel: 'Stop',
            Action: action, OnConfirmed: async () => { this.Acted++ },
        }))
    }

    public RunConfirmByName(dialogs: FakeDialogService, action: () => Promise<void>): Promise<void>
    {
        return this.Guard(() => this.ConfirmByName(dialogs, {
            Capability: AdminCapability.Environments, Expected: 'alpha', Title: 'Delete?', Message: 'Deletes it.',
            Consequences: ['Gone.'], Action: action, OnConfirmed: async () => { this.Acted++ },
        }))
    }

    protected override get PageCapability(): AdminCapability | undefined
    {
        return AdminCapability.Environments
    }

    protected override async LoadCore(): Promise<boolean>
    {
        this.Loads++
        return await this.Next()
    }
}

class SectionA extends TenantSectionService
{
    public static readonly Key = new ServiceKey<SectionA>('SectionA')
    public Roots = 0

    public constructor(provider: IServiceProvider)
    {
        super(provider)
    }

    public Page(name: string): StubPage
    {
        return new StubPage(this.Session, name)
    }

    protected override CreateRoot(): TenantPageViewModel
    {
        this.Roots++
        return new StubPage(this.Session, 'root-a')
    }
}

class SectionB extends TenantSectionService
{
    public static readonly Key = new ServiceKey<SectionB>('SectionB')

    public constructor(provider: IServiceProvider)
    {
        super(provider)
    }

    protected override CreateRoot(): TenantPageViewModel
    {
        return new StubPage(this.Session, 'root-b')
    }
}

class Fixture
{
    public readonly Api = new FakeTenantApi()
    public readonly Host: TenantTestHost
    public readonly Rail: TestRail

    public constructor(capabilities = TenantTestHost.AllCapabilities)
    {
        this.Host = new TenantTestHost(this.Api, capabilities)
        this.Host.Provider.register(SectionA.Key, (p) => new SectionA(p))
        this.Host.Provider.register(SectionB.Key, (p) => new SectionB(p))
        this.Rail = new TestRail(this.Host.Provider)
        this.Rail.Add(SectionA)
        this.Rail.Add(SectionB)
    }

    public get A(): SectionA
    {
        return this.Host.Provider.getRequired(SectionA.Key)
    }

    public get Content(): StubPage
    {
        return this.Host.Host.Content as StubPage
    }
}

describe('TenantSectionService', () =>
{
    it('creates its root once and re-views it on later activations', async () =>
    {
        const f = new Fixture()
        f.Rail.Select(SectionA)
        await Tick.Settle()
        f.Rail.Select(SectionB)
        f.Rail.Select(SectionA)
        await Tick.Settle()
        assert.equal(f.A.Roots, 1)
        assert.equal(f.Content.Name, 'root-a')
    })

    it('keeps a detail page across a rail round-trip, and Back returns to the root', async () =>
    {
        const f = new Fixture()
        f.Rail.Select(SectionA)
        await Tick.Settle()
        const detail = f.A.Page('detail')
        f.A.Present(detail)
        f.Rail.Select(SectionB)
        await Tick.Settle()
        assert.equal(f.Content.Name, 'root-b')
        f.Rail.Select(SectionA)
        await Tick.Settle()
        assert.equal(f.Content, detail)
        f.A.Back()
        assert.equal(f.Content.Name, 'root-a')
        f.A.Back()
        assert.equal(f.Content.Name, 'root-a')
    })

    it('tells a live page when it is shown and hidden (popped or left through the rail)', async () =>
    {
        const f = new Fixture()
        f.Rail.Select(SectionA)
        await Tick.Settle()
        const detail = f.A.Page('detail')
        f.A.Present(detail)
        assert.equal(detail.Shown, 1)
        f.Rail.Select(SectionB)
        assert.equal(detail.Hidden, 1)
        f.Rail.Select(SectionA)
        assert.equal(detail.Shown, 2)
        f.A.Back()
        assert.equal(detail.Hidden, 2)
    })

    it('handles a tenant event by reloading its current page', async () =>
    {
        const f = new Fixture()
        f.Rail.Select(SectionA)
        await Tick.Settle()
        const before = f.Content.Loads
        await f.A.OnTenantEvent({ type: TenantEventType.EnvironmentChanged, environmentName: 'alpha' })
        assert.equal(f.Content.Loads, before + 1)
    })
})

describe('TenantSectionService.Restart', () =>
{
    it('rebuilds the root (built before the session existed) and drops any stacked page', async () =>
    {
        const f = new Fixture()
        f.Rail.Select(SectionA)
        await Tick.Settle()
        const firstRoot = f.Content
        const detail = f.A.Page('detail')
        f.A.Present(detail)
        new LiveUpdateBridge(f.Rail.Navigation, f.Host.Session).RestartActive()
        await Tick.Settle()
        assert.equal(f.A.Roots, 2)
        assert.notEqual(f.Content, firstRoot)
        assert.equal(f.Content.Name, 'root-a')
        assert.equal(detail.Hidden, 1)
        f.A.Back()
        assert.equal(f.Content.Name, 'root-a')
    })
})

describe('TenantPageViewModel', () =>
{
    it('moves Loading -> Populated or Empty', async () =>
    {
        const f = new Fixture()
        const page = f.A.Page('p')
        assert.equal(page.State, PageState.Loading)
        await page.Refresh()
        assert.equal(page.State, PageState.Populated)
        page.Next = async () => false
        await page.Refresh()
        assert.equal(page.State, PageState.Empty)
    })

    it('expires the session once on a 401', async () =>
    {
        const f = new Fixture()
        const page = f.A.Page('p')
        page.Next = async () => { throw new TenantApiError(401, 'unauthorized') }
        await page.Refresh()
        await page.Refresh()
        assert.equal(f.Host.Reloader.Count, 1)
    })

    it('shows Denied on a 403 and Error with the message otherwise', async () =>
    {
        const f = new Fixture()
        const page = f.A.Page('p')
        page.Next = async () => { throw new TenantApiError(403, 'forbidden') }
        await page.Refresh()
        assert.equal(page.State, PageState.Denied)
        assert.ok(page.IsDenied)
        page.Next = async () => { throw new Error('boom') }
        await page.Refresh()
        assert.equal(page.State, PageState.Error)
        assert.equal(page.ErrorText, 'boom')
    })

    it('clears the last command error on a successful reload', async () =>
    {
        const f = new Fixture()
        const page = f.A.Page('p')
        await page.RunConfirm(undefined as unknown as FakeDialogService, async () => undefined)
        assert.notEqual(page.CommandErrorText, '')
        await page.Refresh()
        assert.equal(page.CommandErrorText, '')
    })

    it('discards a superseded load', async () =>
    {
        const f = new Fixture()
        const page = f.A.Page('p')
        let release: (v: boolean) => void = () => undefined
        page.Next = () => new Promise<boolean>(r => { release = r })
        const first = page.Refresh()
        const releaseFirst = release
        page.Next = async () => false
        await page.Refresh()
        releaseFirst(true)
        await first
        assert.equal(page.State, PageState.Empty)
    })

    it('disables a mutating command without its capability and gives the reason', async () =>
    {
        const f = new Fixture({ envs: false, adopt: true, access: true, settings: true })
        const page = f.A.Page('p')
        assert.equal(page.Act.CanExecute(), false)
        page.Act.Execute()
        await Tick.Settle()
        assert.equal(page.Acted, 0)
        assert.equal(page.CanMutate, false)
        assert.equal(page.DeniedReason, 'Needs the Manage environments permission. Ask owner@example.test.')
    })

    it('runs a plain confirm only when confirmed', async () =>
    {
        const f = new Fixture()
        const dialogs = f.Host.UseDialogs()
        const page = f.A.Page('p')
        let ran = 0
        const cancelled = page.RunConfirm(dialogs, async () => { ran++ })
        await Tick.Settle()
        dialogs.Dismiss()
        await cancelled
        assert.equal(ran, 0)
        const confirmed = page.RunConfirm(dialogs, async () => { ran++ })
        await Tick.Settle()
        const dialog = dialogs.Last as ConfirmDialogViewModel
        assert.equal(dialog.ConsequencesText, '')
        dialog.ConfirmCommand.Execute()
        await confirmed
        assert.equal(ran, 1)
        assert.equal(page.Acted, 1)
    })

    it('requires the exact name before an irreversible action', async () =>
    {
        const f = new Fixture()
        const dialogs = f.Host.UseDialogs()
        const page = f.A.Page('p')
        let ran = 0
        const run = page.RunConfirmByName(dialogs, async () => { ran++ })
        await Tick.Settle()
        const dialog = dialogs.Last as NameConfirmDialogViewModel
        assert.equal(dialog.ConsequencesText, '- Gone.')
        dialog.Typed = 'alph'
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
        dialog.Typed = 'alpha'
        assert.equal(dialog.ConfirmCommand.CanExecute(), true)
        dialog.ConfirmCommand.Execute()
        await run
        assert.equal(ran, 1)
    })
})

describe('TenantSessionService', () =>
{
    it('reads the identity plate and capabilities from the profile', () =>
    {
        const f = new Fixture({ envs: true, adopt: false, access: true, settings: true })
        const s = f.Host.Session
        assert.equal(s.TenantLabel, 'Example Tenant')
        assert.equal(s.OrganisationLabel, 'Example Org')
        assert.equal(s.HiveLabel, 'Example Hive')
        assert.equal(s.RoleLabel, 'Tenant owner')
        assert.equal(s.Can(AdminCapability.Adopt), false)
        assert.equal(s.DeniedReason(AdminCapability.Environments), '')
        assert.equal(s.DeniedReason(AdminCapability.Adopt), 'Needs the Adopt versions permission. Ask owner@example.test.')
    })

    it('is permissive when the profile could not be read', () =>
    {
        const host = new TenantTestHost(new FakeTenantApi(), null)
        assert.equal(host.Session.Can(AdminCapability.Access), true)
        assert.equal(host.Session.HiveLabel, '(this hive)')
        assert.equal(host.Session.TenantLabel, 'tenant-1')
        assert.equal(host.Session.OwnerContact, 'your tenant owner')
    })

    it('logs out then reloads once; a second click while in flight is ignored', async () =>
    {
        const f = new Fixture()
        f.Host.Session.LogoutCommand.Execute()
        f.Host.Session.LogoutCommand.Execute()
        await Tick.Settle()
        assert.equal(f.Api.LogoutCount, 1)
        assert.equal(f.Host.Reloader.Count, 1)
    })

    it('keeps the page and reports a logout failure other than 401', async () =>
    {
        const f = new Fixture()
        f.Api.FailOn.set('Logout', new Error('down'))
        await f.Host.Session.Logout()
        assert.equal(f.Host.Reloader.Count, 0)
        assert.equal(f.Host.Session.LogoutError, 'down')
    })

    it('counts recorded activity', () =>
    {
        const f = new Fixture()
        f.Host.Session.RecordEvent({ type: TenantEventType.EnvironmentCreated, environmentName: 'alpha' })
        assert.equal(f.Host.Session.ActivityCountText, 'Activity (1)')
    })

    it('resolves the hive from the profile, else from the hive list', async () =>
    {
        const f = new Fixture()
        assert.equal(await f.Host.Session.ResolveHiveId(), 'hive-1')
        const api = new FakeTenantApi().WithHive('hive-9')
        const host = new TenantTestHost(api, null)
        assert.equal(await host.Session.ResolveHiveId(), 'hive-9')
    })
})

describe('TenantNavigationService', () =>
{
    // A provider whose ApplicationService reports one module with two capabilities.
    const provider = (): ServiceProvider =>
    {
        const p = new ServiceProvider()
        const first = new Capability()
        first.Name = 'First'
        const second = new Capability()
        second.Name = 'Second'
        p.registerInstance(ApplicationService.Key, { Modules: [{ Capabilities: [first, second] }] } as unknown as ApplicationService)
        return p
    }

    it('selects the first destination and keeps the side pane hidden on selection and re-activation', () =>
    {
        const nav = new TenantNavigationService(provider())
        assert.equal(nav.Items.Count, 2)
        assert.equal(nav.SelectedItem, nav.Items.Get(0))
        assert.equal(nav.SidePaneVisible, false)
        const second = nav.Items.Get(1) as NavigationDestination
        nav.SelectedItem = second
        assert.equal(nav.SidePaneVisible, false)
        second.ActivateCommand?.Execute()
        second.ActivateCommand?.Execute()
        assert.equal(nav.SidePaneVisible, false)
    })
})

describe('LiveUpdateBridge', () =>
{
    it('records the event and reloads only the active section, keeping its detail page', async () =>
    {
        const f = new Fixture()
        f.Rail.Select(SectionB)
        await Tick.Settle()
        f.Rail.Select(SectionA)
        await Tick.Settle()
        const detail = f.A.Page('detail')
        f.A.Present(detail)
        await Tick.Settle()
        const b = f.Host.Provider.getRequired(SectionB.Key).Current as StubPage
        const bLoads = b.Loads
        const loads = detail.Loads
        const bridge = new LiveUpdateBridge(f.Rail.Navigation, f.Host.Session)
        await bridge.OnEvent({ type: TenantEventType.HealthChanged, environmentName: 'alpha' })
        assert.equal(detail.Loads, loads + 1)
        assert.equal(b.Loads, bLoads)
        assert.equal(f.Content, detail)
        assert.equal(f.Host.Session.Activity.Count, 1)
    })
})

describe('TenantBoot', () =>
{
    it('signs in on no session or a 401, the shell on a session, and rethrows anything else', async () =>
    {
        assert.equal((await TenantBoot.Decide(async () => null)).Target, BootTarget.SignIn)
        assert.equal((await TenantBoot.Decide(async () => { throw new TenantApiError(401, 'x') })).Target, BootTarget.SignIn)
        assert.equal((await TenantBoot.Decide(async () => ({ id: 1 }))).Target, BootTarget.Shell)
        await assert.rejects(TenantBoot.Decide(async () => { throw new TenantApiError(500, 'down') }), /down/)
    })

    it('reads the profile permissively, except a 401', async () =>
    {
        assert.equal(await TenantBoot.ReadProfile(async () => { throw new TenantApiError(500, 'x') }), undefined)
        await assert.rejects(TenantBoot.ReadProfile(async () => { throw new TenantApiError(401, 'gone') }), /gone/)
    })
})

describe('LoginPageViewModel', () =>
{
    it('starts the identity-provider sign-in once, or retries by reloading', () =>
    {
        const starter = { Count: 0, BeginLogin(): void { this.Count++ } }
        const reloader = new FakeReloader()
        const page = new LoginPageViewModel(starter, reloader)
        page.ShowError('down')
        assert.equal(page.ErrorText, 'down')
        page.SignInCommand.Execute()
        page.SignInCommand.Execute()
        assert.equal(starter.Count, 1)
        assert.equal(page.RetryCommand.CanExecute(), false)
        const other = new LoginPageViewModel(starter, reloader)
        other.RetryCommand.Execute()
        assert.equal(reloader.Count, 1)
    })
})
