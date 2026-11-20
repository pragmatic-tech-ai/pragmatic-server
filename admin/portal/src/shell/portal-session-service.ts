import { ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { AppSessionService, type AppSession, type IPageReloader } from '@pragmatic-tech-ai/pragmatic-app-shell'
import type { ControlPlaneClient } from '../api-client.js'
import { OperatorContext } from '../operator-context.js'

// The signed-in operator for the shell: the shell's session service (expiry on 401, the access notice on 403, Log
// out, Change password) plus what the operator may do, read from the session's app_roles claim (operator.full is an
// Operator; anything else an Observer). Registered at the app root; the boot initializes it before any section
// resolves it.
export class PortalSessionService extends AppSessionService
{
    public static override readonly Key = new ServiceKey<PortalSessionService>('PortalSessionService')

    private static readonly RoleLabelProperty = 'RoleLabel'
    private static readonly CanMutateProperty = 'CanMutate'
    private static readonly DeniedReasonProperty = 'DeniedReason'
    private static readonly ReadOnlyNoticeProperty = 'ReadOnlyNotice'
    private static readonly NotSignedIn = 'Not signed in'
    private static readonly DeniedTemplate = 'Needs the {role} role. Ask {whom}.'
    private static readonly ReadOnlyTemplate = 'Read-only: you are signed in as {role}.'
    private static readonly RoleToken = '{role}'
    private static readonly WhomToken = '{whom}'
    private static readonly Blank = ''

    private operator: OperatorContext | undefined

    public constructor(provider: IServiceProvider)
    {
        super(provider)
    }

    public override Initialize(client: ControlPlaneClient, session: AppSession, reloader: IPageReloader): void
    {
        const before = [this.RoleLabel, this.CanMutate, this.DeniedReason, this.ReadOnlyNotice] as const
        this.operator = OperatorContext.FromAppRoles(session.AppRoles)
        super.Initialize(client, session, reloader)
        const P = PortalSessionService
        this.RaiseIfChanged(P.RoleLabelProperty, before[0], this.RoleLabel)
        this.RaiseIfChanged(P.CanMutateProperty, before[1], this.CanMutate)
        this.RaiseIfChanged(P.DeniedReasonProperty, before[2], this.DeniedReason)
        this.RaiseIfChanged(P.ReadOnlyNoticeProperty, before[3], this.ReadOnlyNotice)
    }

    public override get Client(): ControlPlaneClient
    {
        return super.Client as ControlPlaneClient
    }

    public get RoleLabel(): string
    {
        return this.operator?.RoleLabel ?? PortalSessionService.Blank
    }

    public get CanMutate(): boolean
    {
        return this.operator?.CanMutate ?? false
    }

    // Why a mutating command is disabled; '' when the operator may mutate.
    public get DeniedReason(): string
    {
        if (this.operator === undefined)
        {
            return PortalSessionService.NotSignedIn
        }
        if (this.CanMutate)
        {
            return PortalSessionService.Blank
        }
        return PortalSessionService.DeniedTemplate
            .replace(PortalSessionService.RoleToken, this.operator.NeededRoleLabel)
            .replace(PortalSessionService.WhomToken, this.operator.AskWhom)
    }

    // The header's read-only notice for Observers; '' when the operator may mutate.
    public get ReadOnlyNotice(): string
    {
        if (this.CanMutate || this.operator === undefined)
        {
            return PortalSessionService.Blank
        }
        return PortalSessionService.ReadOnlyTemplate.replace(PortalSessionService.RoleToken, this.operator.RoleLabel)
    }
}
