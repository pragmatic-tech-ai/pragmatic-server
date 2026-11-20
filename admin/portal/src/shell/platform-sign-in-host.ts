import { ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { SignInHostService } from '@pragmatic-tech-ai/pragmatic-app-shell'
import { PlatformShell } from './platform-shell.js'

// Hosts the shell's sign-in page for sign-in.mu, the small application booted when there is no session.
export class PlatformSignInHost extends SignInHostService
{
    public static readonly Key = new ServiceKey<PlatformSignInHost>('PlatformSignInHost')

    public constructor(provider: IServiceProvider)
    {
        super(provider, PlatformShell.Config)
    }
}
