import { ServiceBase, ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { BrowserFormPoster } from './form-poster.js'
import { IdpLoginViewModel } from './idp-login-view-model.js'
import { LoginBootState } from './login-boot-state.js'

// Hosts the sign-in page for login.mu; its root binds DataContext to Page.
export class LoginHostService extends ServiceBase
{
    public static readonly Key = new ServiceKey<LoginHostService>('LoginHostService')
    private static readonly PageShowEvent = 'pageshow'

    private readonly page: IdpLoginViewModel

    public constructor(provider: IServiceProvider)
    {
        super(provider)
        this.page = new IdpLoginViewModel(new BrowserFormPoster(), LoginBootState.FromDocument(document).Failed)
        // A page restored from the back/forward cache keeps its in-memory state (a
        // busy form); reset it so Sign in works again.
        window.addEventListener(LoginHostService.PageShowEvent, (e) =>
        {
            if ((e as PageTransitionEvent).persisted)
            {
                this.page.Reset()
            }
        })
    }

    public get Page(): IdpLoginViewModel
    {
        return this.page
    }
}
