import { ServiceBase, ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { ControlPlaneClient } from '../api-client.js'
import { LoginPageViewModel } from './login-page-view-model.js'
import { BrowserPageReloader } from './page-reloader.js'

// Hosts the sign-in page for login.mu, the small application booted when
// there is no session. Its root binds DataContext to Page.
export class LoginHostService extends ServiceBase
{
    public static readonly Key = new ServiceKey<LoginHostService>('LoginHostService')

    private readonly page: LoginPageViewModel

    public constructor(provider: IServiceProvider)
    {
        super(provider)
        this.page = new LoginPageViewModel(new ControlPlaneClient(), new BrowserPageReloader())
    }

    public get Page(): LoginPageViewModel
    {
        return this.page
    }
}
