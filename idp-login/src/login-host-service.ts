import { ServiceBase, ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { FederatedRoundTrip } from './federated-round-trip.js'
import { IdpLoginViewModel } from './idp-login-view-model.js'
import { BrowserLoginBackend } from './login-backend.js'
import { LoginBootState } from './login-boot-state.js'
import { LoginPageLocation } from './login-page-location.js'
import { BrowserPageNavigator } from './page-navigator.js'

// Hosts the sign-in page for login.mu; its root binds DataContext to Page.
export class LoginHostService extends ServiceBase
{
    public static readonly Key = new ServiceKey<LoginHostService>('LoginHostService')
    private static readonly PageShowEvent = 'pageshow'

    private readonly page: IdpLoginViewModel

    public constructor(provider: IServiceProvider)
    {
        super(provider)
        const roundTrip = new FederatedRoundTrip(window.sessionStorage)
        const location = roundTrip.Locate(LoginPageLocation.FromWindow())
        const fetchFn = globalThis.fetch.bind(globalThis)
        this.page = new IdpLoginViewModel(
            new BrowserLoginBackend(location, fetchFn),
            new BrowserPageNavigator(),
            location,
            roundTrip,
            fetchFn,
            LoginBootState.FromDocument(document).Failed)
        // A page restored from the back/forward cache keeps its in-memory state (a
        // busy form); reset it so the form works again.
        window.addEventListener(LoginHostService.PageShowEvent, (e) =>
        {
            if ((e as PageTransitionEvent).persisted)
            {
                this.page.Reset()
            }
        })
        this.page.Load().catch((e: unknown) => console.error(e))
    }

    public get Page(): IdpLoginViewModel
    {
        return this.page
    }
}
