import { Density, ThemeManager, type Application, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { NavigationService } from '@pragmatic-tech-ai/mural/framework/shell/services/navigation-service.js'
import { HtmlTarget } from '@pragmatic-tech-ai/mural/visual-engine'
import { ApiError, ControlPlaneClient } from '../api-client.js'
import { OperatorContext } from '../operator-context.js'
import type { OperatorDto } from '../portal-types.js'
import { LiveUpdateBridge } from './live-update-bridge.js'
import { LoginHostService } from './login-host-service.js'
import { BrowserPageReloader, type IPageReloader } from './page-reloader.js'
import { PortalSessionService } from './portal-session-service.js'

// Which application the page boots into.
export enum BootTarget
{
    Login,
    Shell,
}

// The probe's outcome: login, or the shell with the session it found.
export type BootDecision<T> =
    | { Target: BootTarget.Login }
    | { Target: BootTarget.Shell, Session: T }

// Boots the portal into a plain browser tab. Probes the session cookie, then
// dynamically imports exactly one compiled .mu application: login.mu when
// there is no session, app.mu (the shell) when there is. Logging in or out
// reloads the page, so each boot starts from a clean slate. Both apps run at
// Compact density, so the sign-in page matches the shell.
export class PortalBoot
{
    private static readonly RootId = 'app'
    private static readonly MissingRootMessage = 'PortalBoot: root element missing'
    private static readonly UnreachablePrefix = "Can't reach the control plane: "
    private static readonly LiveUpdateFailed = 'PortalBoot: live update failed'

    public static async Run(): Promise<void>
    {
        const root = document.getElementById(PortalBoot.RootId)
        if (root === null)
        {
            throw new Error(PortalBoot.MissingRootMessage)
        }
        const client = new ControlPlaneClient()
        let decision: BootDecision<OperatorDto>
        try
        {
            decision = await PortalBoot.Decide(() => client.Session())
        }
        catch (e)
        {
            const { app } = await import('../login.mu.js')
            PortalBoot.ShowProbeFailure(app.Services, e)
            PortalBoot.Mount(app, root)
            return
        }
        if (decision.Target === BootTarget.Login)
        {
            const { app } = await import('../login.mu.js')
            PortalBoot.Mount(app, root)
            return
        }
        const { app } = await import('../app.mu.js')
        const started = PortalBoot.StartShell(app.Services, client, decision.Session, new BrowserPageReloader())
        PortalBoot.Mount(app, root)
        await started
    }

    // Login when the probe finds no session (null, or a 401), the shell with
    // the session when it finds one. Any other failure propagates.
    public static async Decide<T>(probe: () => Promise<T | null | undefined>): Promise<BootDecision<T>>
    {
        try
        {
            const session = await probe()
            if (session === null || session === undefined)
            {
                return { Target: BootTarget.Login }
            }
            return { Target: BootTarget.Shell, Session: session }
        }
        catch (e)
        {
            if (e instanceof ApiError && e.Status === ApiError.UnauthorizedStatus)
            {
                return { Target: BootTarget.Login }
            }
            throw e
        }
    }

    // The login app's message when the session probe failed for a reason other
    // than "not signed in" (control plane down, 5xx, network).
    public static ShowProbeFailure(services: IServiceProvider, failure: unknown): void
    {
        const message = failure instanceof Error ? failure.message : String(failure)
        services.getRequired(LoginHostService.Key).Page.ShowError(PortalBoot.UnreachablePrefix + message)
    }

    // Wires the imported shell to the signed-in session. Importing app.mu.js
    // composes the shell and activates the first section before the session
    // exists, so that section's first load fails. This initializes the session
    // (synchronously, before the first await), routes every control-plane change
    // notification to the active section, and resolves once the active
    // section's page has reloaded with the session.
    public static async StartShell(services: IServiceProvider, client: ControlPlaneClient, operator: OperatorDto, reloader: IPageReloader): Promise<void>
    {
        const session = services.getRequired(PortalSessionService.Key)
        session.Initialize(client, operator.email, OperatorContext.FromWire(operator.role), reloader)
        const bridge = new LiveUpdateBridge(services.getRequired(NavigationService.Key))
        client.OnChanged(() =>
        {
            bridge.OnChanged().catch((e: unknown) => console.error(PortalBoot.LiveUpdateFailed, e))
        })
        await bridge.OnChanged()
    }

    private static Mount(app: Application, root: HTMLElement): void
    {
        ThemeManager.Density = Density.Compact
        app.initialize(new HtmlTarget(root))
    }
}
