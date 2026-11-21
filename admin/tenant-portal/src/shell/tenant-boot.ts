import type { Application, IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { NavigationService } from '@pragmatic-tech-ai/mural/framework/shell/services/navigation-service.js'
import { ApiError, AppShellBoot, BrowserPage, BrowserShellMount, type AppSession, type IPageNavigator, type IPageReloader, type IShellApplications } from '@pragmatic-tech-ai/pragmatic-app-shell'
import { TenantApiClient } from '../tenant-api-client.js'
import type { TenantProfileDto } from '../tenant-types.js'
import { TenantLiveUpdateBridge } from './tenant-live-update-bridge.js'
import { TenantSessionService } from './tenant-session-service.js'
import { TenantSignInHost } from './tenant-sign-in-host.js'

// The console's two compiled applications for the shell's boot: sign-in.mu only when the session probe failed (a
// signed-out visitor goes straight to the identity provider), app.mu (the shell) when there is a session. Before the
// shell is imported the profile is read (its capabilities and identity plate); a 401 there means the session is
// gone, so the browser goes back to the identity provider instead of starting the shell.
export class TenantApplications implements IShellApplications<Application>
{
    private static readonly LiveUpdateFailed = 'TenantBoot: live update failed'

    private profile: TenantProfileDto | undefined
    private profileRefused = false

    public constructor(private readonly client: TenantApiClient, private readonly page: IPageReloader & IPageNavigator)
    {
    }

    public async LoadSignIn(): Promise<Application>
    {
        return (await import('../sign-in.mu.js')).app
    }

    public async LoadShell(): Promise<Application>
    {
        try
        {
            this.profile = await TenantApplications.ReadProfile(() => this.client.Profile())
        }
        catch
        {
            this.profileRefused = true
        }
        return (await import('../app.mu.js')).app
    }

    public ShowSignInError(app: Application, message: string): void
    {
        TenantApplications.ShowSignInError(app.Services, message)
    }

    public StartShell(app: Application, session: AppSession): void
    {
        if (this.profileRefused)
        {
            this.client.BeginOidcSignIn(this.page)
            return
        }
        TenantApplications.StartShell(app.Services, this.client, session, this.profile, this.page)
    }

    public Mount(app: Application): void
    {
        BrowserShellMount.Mount(app)
    }

    // The signed-in profile; undefined when it can't be read (the shell then runs permissive and the server stays
    // the gate). A 401 propagates: the session is gone.
    public static async ReadProfile(read: () => Promise<TenantProfileDto>): Promise<TenantProfileDto | undefined>
    {
        try
        {
            return await read()
        }
        catch (e)
        {
            if (ApiError.Is(e, ApiError.UnauthorizedStatus))
            {
                throw e
            }
            return undefined
        }
    }

    // The sign-in page's message when the session probe failed for a reason other than "not signed in".
    public static ShowSignInError(services: IServiceProvider, message: string): void
    {
        services.getRequired(TenantSignInHost.Key).Page.ShowError(message)
    }

    // Wires the imported shell to the signed-in session. Importing app.mu.js composes the shell and activates the
    // first section before the session exists, so that section's first load fails. This initializes the session
    // (synchronously, before the shell mounts), routes every tenant event through the live-update bridge, and rebuilds
    // the active section's root page (it was built without the session's permissions).
    public static StartShell(services: IServiceProvider, client: TenantApiClient, session: AppSession,
        profile: TenantProfileDto | undefined, reloader: IPageReloader): void
    {
        const tenantSession = services.getRequired(TenantSessionService.Key)
        tenantSession.Initialize(client, session, reloader, undefined, profile)
        const bridge = new TenantLiveUpdateBridge(services.getRequired(NavigationService.Key), tenantSession)
        client.OnEvent(ev =>
        {
            bridge.OnEvent(ev).catch((e: unknown) => console.error(TenantApplications.LiveUpdateFailed, e))
        })
        bridge.RestartActive()
    }
}

// Boots the Tenant Admin into a plain browser tab through the shell's boot: probes the session cookie, then sends a
// signed-out visitor to the identity provider, mounts the shell, or (probe failed) the sign-in page saying why.
export class TenantBoot
{
    public static async Run(): Promise<void>
    {
        const client = new TenantApiClient()
        const page = new BrowserPage()
        await new AppShellBoot(client, new TenantApplications(client, page), page).Run()
    }
}
