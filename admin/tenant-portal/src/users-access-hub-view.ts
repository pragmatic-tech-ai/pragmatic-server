import { Orientation, StackPanel } from '@pragmatic-tech-ai/mural/basic'
import { ScreenHost } from './kit/screen-host.js'
import type { IUsersAccessSource, ITenantNavigator } from './tenant-types.js'
import { TenantViewBase } from './tenant-view-base.js'
import { UsersAccessView } from './users-access-view.js'

// "Users & Access" hub: hosts the Users view by default, with a button strip routing
// to the other identity screens through the navigator.
export class UsersAccessHubView extends TenantViewBase
{
    public static readonly UsersLabel = 'Users'
    public static readonly ServiceTokensLabel = 'Service tokens'
    public static readonly RolesPrivilegesLabel = 'Roles & privileges'
    public static readonly FieldSecurityLabel = 'Field security'

    private static readonly DeniedWhat = 'Users & Access'
    private static readonly DeniedNeed = 'the Manage users & access permission'

    private readonly users: UsersAccessView
    private denied: ScreenHost | undefined

    public constructor(source: IUsersAccessSource, currentPrincipalId: string)
    {
        super()
        this.users = new UsersAccessView(source, currentPrincipalId)
        this.Orientation = Orientation.Vertical
        this.BuildAllowed()
    }

    // Test seam: the Denied ScreenHost when the access capability is withheld, else undefined.
    public get DeniedHost(): ScreenHost | undefined
    {
        return this.denied
    }

    // Test seam: the view shown as the default body.
    public get Active(): UsersAccessView
    {
        return this.users
    }

    public override AttachNavigator(nav: ITenantNavigator): void
    {
        super.AttachNavigator(nav)
        // The capability is only known once the navigator is attached; undefined is permissive.
        const allowed = this.Navigator?.Capabilities?.access !== false
        if (allowed)
        {
            this.users.AttachNavigator(nav)
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
            await this.users.Refresh()
        }
    }

    public Dispose(): void
    {
        this.users.Dispose()
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
        this.AddChild(this.MakeStrip())
        this.AddChild(this.users)
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
                what: UsersAccessHubView.DeniedWhat,
                need: UsersAccessHubView.DeniedNeed,
                who: this.Navigator?.OwnerContact,
            },
        })
        this.AddChild(this.denied)
    }

    private MakeStrip(): StackPanel
    {
        const strip = new StackPanel()
        strip.Orientation = Orientation.Horizontal
        strip.AddChild(this.MakeButton(UsersAccessHubView.UsersLabel, () => { }))
        strip.AddChild(this.MakeButton(UsersAccessHubView.ServiceTokensLabel, () => this.Navigator?.ShowServiceTokens()))
        strip.AddChild(this.MakeButton(UsersAccessHubView.RolesPrivilegesLabel, () => this.Navigator?.ShowRolesPrivileges()))
        strip.AddChild(this.MakeButton(UsersAccessHubView.FieldSecurityLabel, () => this.Navigator?.ShowFieldSecurity()))
        return strip
    }
}
