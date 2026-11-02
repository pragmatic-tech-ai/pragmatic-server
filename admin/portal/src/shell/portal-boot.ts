import { Density, ThemeManager, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { NavigationService } from '@pragmatic-tech-ai/mural/framework/shell/services/navigation-service.js'
import { HtmlTarget } from '@pragmatic-tech-ai/mural/visual-engine'
import { ApiError, ControlPlaneClient } from '../api-client.js'
import { OperatorContext } from '../operator-context.js'
import type { OperatorDto } from '../portal-types.js'
import { LiveUpdateBridge } from './live-update-bridge.js'
import { BrowserPageReloader, type IPageReloader } from './page-reloader.js'
import { PortalSessionService } from './portal-session-service.js'

// Which application the page boots into.
export enum BootTarget
{
    Login,
    Shell,
}

// Boots the portal into a plain browser tab. Probes the session cookie, then
// dynamically imports exactly one compiled .mu application: login.mu when
// there is no session, app.mu (the shell) when there is. Logging in or out
// reloads the page, so each boot starts from a clean slate.
export class PortalBoot
{
    private static readonly RootId = 'app'
    private static readonly MissingRootMessage = 'PortalBoot: root element missing'

    public static async Run(): Promise<void>
    {
        const root = document.getElementById(PortalBoot.RootId)
        if (root === null)
        {
            throw new Error(PortalBoot.MissingRootMessage)
        }
        const client = new ControlPlaneClient()
        const probed: { session: OperatorDto | null } = { session: null }
        const target = await PortalBoot.Decide(async () =>
        {
            probed.session = await client.Session()
            return probed.session
        })
        const session = probed.session
        if (target === BootTarget.Login || session === null)
        {
            const { app } = await import('../login.mu.js')
            ThemeManager.Density = Density.Compact
            app.initialize(new HtmlTarget(root))
            return
        }
        const { app } = await import('../app.mu.js')
        void PortalBoot.StartShell(app.Services, client, session, new BrowserPageReloader())
        ThemeManager.Density = Density.Compact
        app.initialize(new HtmlTarget(root))
    }

    // Login when the probe finds no session (null, or a 401), the shell when
    // it finds one. Any other failure propagates.
    public static async Decide(probe: () => Promise<unknown>): Promise<BootTarget>
    {
        try
        {
            const session = await probe()
            return session === null || session === undefined ? BootTarget.Login : BootTarget.Shell
        }
        catch (e)
        {
            if (e instanceof ApiError && e.Status === ApiError.UnauthorizedStatus)
            {
                return BootTarget.Login
            }
            throw e
        }
    }

    // Wires the imported shell to the signed-in session. Importing app.mu.js
    // composes the shell and activates the first section before the session
    // exists, so that section's first load fails; this initializes the session,
    // reloads the active section's page with it, and from then on refreshes the
    // active section on every control-plane change notification.
    public static async StartShell(services: IServiceProvider, client: ControlPlaneClient, operator: OperatorDto, reloader: IPageReloader): Promise<void>
    {
        const session = services.getRequired(PortalSessionService.Key)
        session.Initialize(client, operator.email, OperatorContext.FromWire(operator.role), reloader)
        const bridge = new LiveUpdateBridge(services.getRequired(NavigationService.Key))
        client.OnChanged(() => { void bridge.OnChanged() })
        await bridge.OnChanged()
    }
}
