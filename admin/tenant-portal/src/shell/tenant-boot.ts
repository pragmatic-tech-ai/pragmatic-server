import { Density, ThemeManager, type Application, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { NavigationService } from '@pragmatic-tech-ai/mural/framework/shell/services/navigation-service.js'
import { HtmlTarget } from '@pragmatic-tech-ai/mural/visual-engine'
import { TenantApiClient, TenantApiError } from '../tenant-api-client.js'
import type { SessionDto, TenantProfileDto } from '../tenant-types.js'
import { LiveUpdateBridge } from './live-update-bridge.js'
import { LoginHostService } from './login-host-service.js'
import { BrowserPageReloader, type IPageReloader } from './page-reloader.js'
import { TenantSessionService } from './tenant-session-service.js'

// Which application the page boots into.
export enum BootTarget
{
    SignIn,
    Shell,
}

// The probe's outcome: sign in, or the shell with the session it found.
export type BootDecision<T> =
    | { Target: BootTarget.SignIn }
    | { Target: BootTarget.Shell, Session: T }

// Boots the Tenant Admin into a plain browser tab. Probes the session cookie:
// no session sends the browser to the tenant's identity provider (as before;
// the control plane's login smoke relies on it); a failed probe imports
// login.mu, which says why; a session imports app.mu (the shell). Logging out
// or a 401 reloads the page, so each boot starts from a clean slate. Both apps
// run at Compact density.
export class TenantBoot
{
    private static readonly RootId = 'app'
    private static readonly MissingRootMessage = 'TenantBoot: root element missing'
    private static readonly UnreachablePrefix = "Can't reach the tenant admin service: "
    private static readonly LiveUpdateFailed = 'TenantBoot: live update failed'

    public static async Run(): Promise<void>
    {
        const root = document.getElementById(TenantBoot.RootId)
        if (root === null)
        {
            throw new Error(TenantBoot.MissingRootMessage)
        }
        const client = new TenantApiClient()
        let decision: BootDecision<SessionDto>
        let profile: TenantProfileDto | undefined
        try
        {
            decision = await TenantBoot.Decide(() => client.Session())
            if (decision.Target === BootTarget.Shell)
            {
                profile = await TenantBoot.ReadProfile(() => client.Profile())
            }
        }
        catch (e)
        {
            if (TenantBoot.IsUnauthorized(e))
            {
                client.BeginLogin()
                return
            }
            const { app } = await import('../login.mu.js')
            TenantBoot.ShowProbeFailure(app.Services, e)
            TenantBoot.Mount(app, root)
            return
        }
        if (decision.Target === BootTarget.SignIn)
        {
            client.BeginLogin()
            return
        }
        const { app } = await import('../app.mu.js')
        const started = TenantBoot.StartShell(app.Services, client, decision.Session, profile, new BrowserPageReloader())
        TenantBoot.Mount(app, root)
        await started
    }

    // Sign in when the probe finds no session (null, or a 401), the shell with
    // the session when it finds one. Any other failure propagates.
    public static async Decide<T>(probe: () => Promise<T | null | undefined>): Promise<BootDecision<T>>
    {
        try
        {
            const session = await probe()
            if (session === null || session === undefined)
            {
                return { Target: BootTarget.SignIn }
            }
            return { Target: BootTarget.Shell, Session: session }
        }
        catch (e)
        {
            if (TenantBoot.IsUnauthorized(e))
            {
                return { Target: BootTarget.SignIn }
            }
            throw e
        }
    }

    // The signed-in profile; undefined when it can't be read (the shell then
    // runs permissive and the server stays the gate). A 401 propagates: the
    // session is gone.
    public static async ReadProfile(read: () => Promise<TenantProfileDto>): Promise<TenantProfileDto | undefined>
    {
        try
        {
            return await read()
        }
        catch (e)
        {
            if (TenantBoot.IsUnauthorized(e))
            {
                throw e
            }
            return undefined
        }
    }

    // The sign-in app's message when the session probe failed for a reason
    // other than "not signed in" (service down, 5xx, network).
    public static ShowProbeFailure(services: IServiceProvider, failure: unknown): void
    {
        const message = failure instanceof Error ? failure.message : String(failure)
        services.getRequired(LoginHostService.Key).Page.ShowError(TenantBoot.UnreachablePrefix + message)
    }

    // Wires the imported shell to the signed-in session. Importing app.mu.js
    // composes the shell and activates the first section before the session
    // exists, so that section's first load fails. This initializes the session
    // (synchronously, before the first await), routes every tenant event
    // through the live-update bridge, and resolves once the active section's
    // page has reloaded with the session.
    public static async StartShell(services: IServiceProvider, client: TenantApiClient, session: SessionDto,
        profile: TenantProfileDto | undefined, reloader: IPageReloader): Promise<void>
    {
        const tenantSession = services.getRequired(TenantSessionService.Key)
        tenantSession.Initialize(client, session, profile, reloader)
        const bridge = new LiveUpdateBridge(services.getRequired(NavigationService.Key), tenantSession)
        client.OnEvent(ev =>
        {
            bridge.OnEvent(ev).catch((e: unknown) => console.error(TenantBoot.LiveUpdateFailed, e))
        })
        await bridge.RefreshActive()
    }

    private static IsUnauthorized(e: unknown): boolean
    {
        return e instanceof TenantApiError && e.Status === TenantApiError.UnauthorizedStatus
    }

    private static Mount(app: Application, root: HTMLElement): void
    {
        ThemeManager.Density = Density.Compact
        app.initialize(new HtmlTarget(root))
    }
}
