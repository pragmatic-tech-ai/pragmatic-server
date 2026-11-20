import { ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { SignInHostService } from '@pragmatic-tech-ai/pragmatic-app-shell'
import { TenantShell } from './tenant-shell.js'

// Hosts the shell's sign-in page for sign-in.mu. A signed-out visitor never sees it (the boot sends them to the
// identity provider); it shows only when the session probe failed, saying why, with Sign in and Try again.
export class TenantSignInHost extends SignInHostService
{
    public static readonly Key = new ServiceKey<TenantSignInHost>('TenantSignInHost')

    public constructor(provider: IServiceProvider)
    {
        super(provider, TenantShell.Config)
    }
}
