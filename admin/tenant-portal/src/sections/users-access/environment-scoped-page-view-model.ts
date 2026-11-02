import { TenantPageViewModel } from '../../shell/tenant-page-view-model.js'
import type { TenantSessionService } from '../../shell/tenant-session-service.js'

// A Users & Access tab (Users, Roles & permissions, Tokens). Accounts,
// grants, tokens and the security model are kept per environment on the
// tenant surface, so each tab works on the environment the page's picker
// selected. Without one (the tenant has no environments) a tab is Empty.
export abstract class EnvironmentScopedPageViewModel extends TenantPageViewModel
{
    private static readonly EnvironmentProperty = 'Environment'

    private environment: string | undefined

    protected constructor(session: TenantSessionService)
    {
        super(session)
    }

    // The environment this tab shows; undefined when there is none.
    public get Environment(): string | undefined
    {
        return this.environment
    }

    // Points the tab at an environment and reloads it. A no-op when it is
    // already that environment (use Refresh to reload).
    public async UseEnvironment(name: string | undefined): Promise<void>
    {
        if (this.environment === name)
        {
            return
        }
        const old = this.environment
        this.environment = name
        this.RaisePropertyChanged(EnvironmentScopedPageViewModel.EnvironmentProperty, old, name)
        this.OnEnvironmentChanged()
        await this.Refresh()
    }

    // Drops whatever the tab held for the previous environment (a one-time
    // value, a draft) before the new one loads.
    protected OnEnvironmentChanged(): void
    {
    }

    protected override async LoadCore(): Promise<boolean>
    {
        const environment = this.environment
        if (environment === undefined)
        {
            return false
        }
        return await this.LoadFor(environment)
    }

    // Loads the tab for `environment`; true when there is content to show.
    protected abstract LoadFor(environment: string): Promise<boolean>
}
