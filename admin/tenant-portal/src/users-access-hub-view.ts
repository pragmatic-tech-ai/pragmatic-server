import { Orientation, StackPanel } from '@pragmatic-tech-ai/mural/basic'
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

    private readonly users: UsersAccessView

    public constructor(source: IUsersAccessSource, currentPrincipalId: string)
    {
        super()
        this.users = new UsersAccessView(source, currentPrincipalId)
        this.Orientation = Orientation.Vertical
        this.AddChild(this.MakeStrip())
        this.AddChild(this.users)
    }

    // Test seam: the view shown as the default body.
    public get Active(): UsersAccessView
    {
        return this.users
    }

    public override AttachNavigator(nav: ITenantNavigator): void
    {
        super.AttachNavigator(nav)
        this.users.AttachNavigator(nav)
    }

    public async Refresh(): Promise<void>
    {
        await this.users.Refresh()
    }

    public Dispose(): void
    {
        this.users.Dispose()
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
