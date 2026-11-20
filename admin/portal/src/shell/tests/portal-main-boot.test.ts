import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ServiceProvider, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { ContentHostService } from '@pragmatic-tech-ai/mural/framework/shell/services/content-host-service.js'
import { ApiError, type ControlPlaneClient } from '../../api-client.js'
import { OperatorContext } from '../../operator-context.js'
import { PlatformSignInHost } from '../platform-sign-in-host.js'
import { PortalApplications } from '../portal-boot.js'
import { PageState, PortalPageViewModel } from '../portal-page-view-model.js'
import { PortalSectionService } from '../portal-section-service.js'
import { PortalSessionService } from '../portal-session-service.js'
import { FakeReloader, PortalTestHost, TestRail, Tick } from './portal-test-fixtures.js'

// A client with one list call plus the change-notification registration.
class FakeShellClient
{
    public readonly Handlers: (() => void)[] = []
    public Lists = 0

    public async ListFleet(): Promise<unknown[]>
    {
        this.Lists++
        return [{}]
    }

    public OnChanged(handler: () => void): void
    {
        this.Handlers.push(handler)
    }

    public AsClient(): ControlPlaneClient
    {
        return PortalTestHost.Equip(this as unknown as ControlPlaneClient)
    }
}

// A page that loads through the session's client, as every real page does:
// before the session is initialized its load fails.
class ClientPage extends PortalPageViewModel
{
    protected override async LoadCore(): Promise<boolean>
    {
        const rows = await this.Session.Client.ListFleet()
        return rows.length > 0
    }
}

class HomeSection extends PortalSectionService
{
    public Root: ClientPage | undefined

    public constructor(provider: IServiceProvider)
    {
        super(provider)
    }

    protected override CreateRoot(): PortalPageViewModel
    {
        this.Root = new ClientPage(this.Session)
        return this.Root
    }
}

// The services app.mu composes, with the home section already activated by
// the rail before the session is initialized (as importing app.mu.js does).
class ShellFixture
{
    public static readonly Operator = PortalTestHost.SessionFor(OperatorContext.ReadOnlyWireRole)

    public readonly Provider = new ServiceProvider()
    public readonly Client = new FakeShellClient()
    public readonly Reloader = new FakeReloader()
    public readonly Rail: TestRail

    public constructor()
    {
        this.Provider.register(PortalSessionService.Key, (p) => new PortalSessionService(p))
        this.Provider.register(ContentHostService.Key, (p) => new ContentHostService(p))
        this.Provider.register(HomeSection, (p) => new HomeSection(p))
        this.Rail = new TestRail(this.Provider)
        this.Rail.Select(HomeSection)
    }

    public get Home(): HomeSection
    {
        return this.Provider.getRequired(HomeSection)
    }

    public get Session(): PortalSessionService
    {
        return this.Provider.getRequired(PortalSessionService.Key)
    }
}

describe('PortalApplications.StartShell', () =>
{
    it('initializes the session and reloads the active section page with it', async () =>
    {
        const f = new ShellFixture()
        await Tick.Next()
        assert.equal(f.Home.Root?.State, PageState.Error)
        assert.equal(f.Client.Lists, 0)

        await PortalApplications.StartShell(f.Provider, f.Client.AsClient(), ShellFixture.Operator, f.Reloader)

        assert.equal(f.Session.Email, PortalTestHost.Email)
        assert.equal(f.Session.CanMutate, false)
        assert.equal(f.Client.Lists, 1)
        assert.equal(f.Home.Root?.State, PageState.Populated)
    })

    it('subscribes change notifications to refresh the active section', async () =>
    {
        const f = new ShellFixture()
        await PortalApplications.StartShell(f.Provider, f.Client.AsClient(), ShellFixture.Operator, f.Reloader)
        assert.equal(f.Client.Handlers.length, 1)
        f.Client.Handlers[0]()
        await Tick.Next()
        assert.equal(f.Client.Lists, 2)
    })

    it('a 401 on the post-initialize reload expires the session once', async () =>
    {
        const f = new ShellFixture()
        f.Client.ListFleet = () => Promise.reject(new ApiError(ApiError.UnauthorizedStatus, 'unauthorized'))
        await PortalApplications.StartShell(f.Provider, f.Client.AsClient(), ShellFixture.Operator, f.Reloader)
        f.Client.Handlers[0]()
        await Tick.Next()
        assert.equal(f.Reloader.Count, 1)
    })
})

describe('PortalApplications.ShowSignInError', () =>
{
    it("shows the boot's reason on the sign-in page", () =>
    {
        const provider = new ServiceProvider()
        provider.register(PlatformSignInHost.Key, (p) => new PlatformSignInHost(p))
        PortalApplications.ShowSignInError(provider, "Can't reach Platform Admin: boom")
        assert.equal(provider.getRequired(PlatformSignInHost.Key).Page.ErrorText, "Can't reach Platform Admin: boom")
    })

    it('the sign-in page offers password sign-in only', () =>
    {
        const host = new PlatformSignInHost(new ServiceProvider())
        assert.equal(host.Page.OffersPassword, true)
        assert.equal(host.Page.OffersOidc, false)
        assert.equal(host.Page.ProductName, 'Platform Admin')
    })
})
