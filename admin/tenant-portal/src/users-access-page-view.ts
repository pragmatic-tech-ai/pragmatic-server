import { Orientation } from '@pragmatic-tech-ai/mural/basic'
import { ScreenHost } from './kit/screen-host.js'
import { Tabs } from './kit/tabs.js'
import { SecurityModelView } from './security-model-view.js'
import type { ISecurityModelEnvSource } from './security-model-view-model.js'
import { ServiceTokensView } from './service-tokens-view.js'
import type { ITenantNavigator, ITokensSource, IUsersAccessSource } from './tenant-types.js'
import { TenantViewBase } from './tenant-view-base.js'
import { UsersAccessView } from './users-access-view.js'

// "Users & Access" page: one kit Tabs host over the Users, Roles & permissions and Tokens
// views, with a whole-page denied gate and lazy per-tab loading (a tab loads on first activation).
export class UsersAccessPageView extends TenantViewBase
{
    private static readonly UsersLabel = 'Users'
    private static readonly RolesLabel = 'Roles & permissions'
    private static readonly TokensLabel = 'Tokens'
    private static readonly DeniedWhat = 'Users & Access'
    private static readonly DeniedNeed = 'the Manage users & access permission'

    private readonly users: UsersAccessView
    private readonly roles: SecurityModelView
    private readonly tokens: ServiceTokensView
    private readonly tabs: Tabs
    private readonly loaded = new Set<number>()
    private denied: ScreenHost | undefined

    public constructor(source: IUsersAccessSource & ISecurityModelEnvSource & ITokensSource, currentPrincipalId: string)
    {
        super()
        this.users = new UsersAccessView(source, currentPrincipalId)
        this.roles = new SecurityModelView(source)
        this.tokens = new ServiceTokensView(source)
        this.tabs = new Tabs({
            entries: [
                { label: UsersAccessPageView.UsersLabel, content: this.users },
                { label: UsersAccessPageView.RolesLabel, content: this.roles },
                { label: UsersAccessPageView.TokensLabel, content: this.tokens },
            ],
            onSelect: (index: number): void => { void this.LoadOnce(index) },
        })
        this.Orientation = Orientation.Vertical
        this.BuildAllowed()
    }

    // Test seam: the tab host.
    public get Tabs(): Tabs
    {
        return this.tabs
    }

    // Test seam: the embedded Users view.
    public get Users(): UsersAccessView
    {
        return this.users
    }

    // Test seam: the embedded Roles & permissions view.
    public get Roles(): SecurityModelView
    {
        return this.roles
    }

    // Test seam: the embedded Tokens view.
    public get Tokens(): ServiceTokensView
    {
        return this.tokens
    }

    // Test seam: the Denied ScreenHost when the access capability is withheld, else undefined.
    public get DeniedHost(): ScreenHost | undefined
    {
        return this.denied
    }

    public override AttachNavigator(nav: ITenantNavigator): void
    {
        super.AttachNavigator(nav)
        this.users.AttachNavigator(nav)
        this.roles.AttachNavigator(nav)
        this.tokens.AttachNavigator(nav)
        // The capability is only known once the navigator is attached; undefined is permissive.
        if (this.Navigator?.Capabilities?.access !== false)
        {
            if (this.denied !== undefined)
            {
                this.BuildAllowed()
            }
        }
        else
        {
            this.BuildDenied()
        }
    }

    public async Refresh(): Promise<void>
    {
        if (this.denied === undefined)
        {
            await this.LoadOnce(this.tabs.ActiveIndex)
        }
    }

    public Dispose(): void
    {
        this.users.Dispose()
        this.roles.Dispose()
        this.tokens.Dispose()
    }

    private async LoadOnce(index: number): Promise<void>
    {
        if (this.loaded.has(index))
        {
            return
        }
        this.loaded.add(index)
        await this.ViewAt(index).Refresh()
    }

    private ViewAt(index: number): UsersAccessView | SecurityModelView | ServiceTokensView
    {
        const views = [this.users, this.roles, this.tokens]
        return views[index]
    }

    private ClearBody(): void
    {
        for (const child of [...this.Children])
        {
            this.RemoveChild(child)
        }
    }

    private BuildAllowed(): void
    {
        this.ClearBody()
        this.denied = undefined
        this.AddChild(this.tabs)
    }

    private BuildDenied(): void
    {
        this.ClearBody()
        this.denied = new ScreenHost({
            loading: false,
            allowed: false,
            isEmpty: false,
            error: false,
            denied: {
                what: UsersAccessPageView.DeniedWhat,
                need: UsersAccessPageView.DeniedNeed,
                who: this.Navigator?.OwnerContact,
            },
        })
        this.AddChild(this.denied)
    }
}
