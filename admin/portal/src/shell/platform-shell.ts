import { AppShellConfig, SignInMethod } from '@pragmatic-tech-ai/pragmatic-app-shell'

// What the platform admin console tells the shared client shell about itself: the product name, password sign-in
// only (the operators' break-glass accounts; OIDC operator sign-in comes later), the host's default session, login,
// logout and WebSocket-ticket routes, and the operator's own-password change at /api/session/password.
export class PlatformShell
{
    private static readonly ProductName = 'Platform Admin'
    private static readonly ChangePasswordPath = '/api/session/password'

    public static readonly Config = new AppShellConfig({
        ProductName: PlatformShell.ProductName,
        SignInMethods: [SignInMethod.Password],
        Paths: { ChangePassword: PlatformShell.ChangePasswordPath },
    })
}
