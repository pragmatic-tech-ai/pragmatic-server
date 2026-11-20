import { AppShellConfig, SignInMethod } from '@pragmatic-tech-ai/pragmatic-app-shell'

// What the tenant admin console tells the shared client shell about itself: OIDC sign-in only (a signed-out visitor
// goes straight to the tenant's identity provider), the console's own auth routes under /tenant-auth/, the WebSocket
// ticket under /tenant-api/, and no own-password change (the credential belongs to the realm), so the header hides
// Change password instead of greying it.
export class TenantShell
{
    // The session claim that names the tenant the session belongs to.
    public static readonly TenantClaim = 'tenant'

    private static readonly ProductName = 'Tenant Admin'
    private static readonly SessionPath = '/tenant-auth/session'
    private static readonly LogoutPath = '/tenant-auth/logout'
    private static readonly OidcBeginPath = '/tenant-auth/oidc/begin'
    private static readonly WsTicketPath = '/tenant-api/ws-ticket'

    public static readonly Config = new AppShellConfig({
        ProductName: TenantShell.ProductName,
        SignInMethods: [SignInMethod.Oidc],
        Paths: {
            Session: TenantShell.SessionPath,
            Logout: TenantShell.LogoutPath,
            OidcBegin: TenantShell.OidcBeginPath,
            WsTicket: TenantShell.WsTicketPath,
        },
        HideUnofferedActions: true,
    })
}
