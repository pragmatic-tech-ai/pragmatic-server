import { Orientation, StackPanel, TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { ComboBox } from '@pragmatic-tech-ai/mural/framework'
import type { ControlPlaneClient } from './api-client.js'
import type { AccountDto, AdminSnapshotDto, GrantDto, IdentityConfigDto, IPortalNavigator } from './portal-types.js'
import { PortalViewBase } from './portal-view-base.js'

// ComboBox item: Mural's collapsed selection text reads Label.
export class RoleOption
{
    public constructor(public readonly Label: string)
    {
    }
}

// Environment administration: accounts, role grants, and the security-model JSON editor.
export class ManageView extends PortalViewBase
{
    private static readonly AccountsHeading = 'Accounts'
    private static readonly GrantsHeading = 'Role grants'
    private static readonly SecurityHeading = 'Security model'
    private static readonly DisabledSuffix = ' (disabled)'
    private static readonly NoSuffix = ''
    private static readonly Separator = ' - '
    private static readonly SubjectPrefix = 'Subject: '
    private static readonly OnKeyword = ' on '
    private static readonly PathJoin = ' '
    private static readonly PathSeparator = '/'
    private static readonly DisableLabel = 'Disable'
    private static readonly CreateLabel = 'Create'
    private static readonly RevokeLabel = 'Revoke'
    private static readonly GrantLabel = 'Grant'
    private static readonly SaveLabel = 'Save'
    private static readonly EmailPlaceholder = 'Email'
    private static readonly PrincipalPlaceholder = 'Principal id'
    private static readonly PasswordPlaceholder = 'Password'
    private static readonly SubjectPlaceholder = 'Subject (principal id or group)'
    private static readonly RolePlaceholder = 'Role'
    private static readonly KindPlaceholder = 'Resource kind'
    private static readonly PathPlaceholder = 'Resource path (optional)'
    private static readonly DefaultResourceKind = 'Tenant'
    private static readonly LabelPath = 'Label'
    private static readonly RoleNames = ['Owner', 'Admin', 'Editor', 'Viewer']
    private static readonly JsonIndent = 2
    private static readonly NoRole = 'Choose a role'

    private readonly accountsPanel = new StackPanel()
    private readonly grantsPanel = new StackPanel()
    private readonly emailBox = new TextBox()
    private readonly principalBox = new TextBox()
    private readonly passwordBox = new TextBox()
    private readonly subjectBox = new TextBox()
    private readonly roleBox = new ComboBox()
    private readonly kindBox = new TextBox()
    private readonly pathBox = new TextBox()
    private readonly modelBox = new TextBox()
    private config: IdentityConfigDto | undefined
    private lastModelText = ''

    public constructor(private readonly client: ControlPlaneClient, private readonly nav: IPortalNavigator, private readonly name: string)
    {
        super()
        this.AddChild(this.Heading(this.name))
        this.AddChild(this.MakeButton(PortalViewBase.BackLabel, () => { this.nav.ShowDetail(this.name) }))
        this.AddChild(this.message)

        this.AddChild(this.Heading(ManageView.AccountsHeading))
        this.AddChild(this.accountsPanel)
        this.emailBox.Placeholder = ManageView.EmailPlaceholder
        this.principalBox.Placeholder = ManageView.PrincipalPlaceholder
        this.passwordBox.Placeholder = ManageView.PasswordPlaceholder
        this.AddChild(this.emailBox)
        this.AddChild(this.principalBox)
        this.AddChild(this.passwordBox)
        this.AddChild(this.MakeButton(ManageView.CreateLabel, () => { void this.SubmitAccount() }))

        this.AddChild(this.Heading(ManageView.GrantsHeading))
        this.AddChild(this.grantsPanel)
        this.subjectBox.Placeholder = ManageView.SubjectPlaceholder
        this.roleBox.Placeholder = ManageView.RolePlaceholder
        this.roleBox.DisplayMemberPath = ManageView.LabelPath
        this.roleBox.ItemsSource = ManageView.RoleNames.map(r => new RoleOption(r))
        this.roleBox.SelectedIndex = 0
        this.kindBox.Placeholder = ManageView.KindPlaceholder
        this.kindBox.Text = ManageView.DefaultResourceKind
        this.pathBox.Placeholder = ManageView.PathPlaceholder
        this.AddChild(this.subjectBox)
        this.AddChild(this.roleBox)
        this.AddChild(this.kindBox)
        this.AddChild(this.pathBox)
        this.AddChild(this.MakeButton(ManageView.GrantLabel, () => { void this.SubmitGrant() }))

        this.AddChild(this.Heading(ManageView.SecurityHeading))
        this.modelBox.AcceptsReturn = true
        this.AddChild(this.modelBox)
        this.AddChild(this.MakeButton(ManageView.SaveLabel, () => { void this.SaveModel() }))
    }

    public async Refresh(): Promise<void>
    {
        try
        {
            const snapshot = await this.client.Snapshot(this.name)
            this.ShowSnapshot(snapshot)
            this.message.Text = PortalViewBase.NoMessage
        }
        catch (e)
        {
            this.ShowError(e)
        }
    }

    private ShowSnapshot(snapshot: AdminSnapshotDto): void
    {
        this.config = snapshot.config
        const loaded = JSON.stringify(snapshot.config.securityModel ?? {}, null, ManageView.JsonIndent)
        // Keep unsaved operator edits: only overwrite the editor when it still shows the last-loaded text.
        if (this.modelBox.Text === this.lastModelText)
        {
            this.modelBox.Text = loaded
            this.lastModelText = loaded
        }
        this.Clear(this.accountsPanel)
        for (const a of snapshot.accounts)
        {
            this.accountsPanel.AddChild(this.AccountRow(a))
        }
        this.Clear(this.grantsPanel)
        for (const [subject, grants] of this.GroupBySubject(snapshot.grants))
        {
            const label = new TextBlock()
            label.Text = ManageView.SubjectPrefix + subject
            this.grantsPanel.AddChild(label)
            for (const g of grants)
            {
                this.grantsPanel.AddChild(this.GrantRow(g))
            }
        }
    }

    private GroupBySubject(grants: GrantDto[]): Map<string, GrantDto[]>
    {
        const groups = new Map<string, GrantDto[]>()
        for (const g of grants)
        {
            const list = groups.get(g.subject)
            if (list === undefined)
            {
                groups.set(g.subject, [g])
            }
            else
            {
                list.push(g)
            }
        }
        return groups
    }

    private AccountRow(a: AccountDto): StackPanel
    {
        const row = new StackPanel()
        row.Orientation = Orientation.Horizontal
        const text = new TextBlock()
        text.Text = a.email + ManageView.Separator + a.principalId + (a.disabled ? ManageView.DisabledSuffix : ManageView.NoSuffix)
        row.AddChild(text)
        if (!a.disabled)
        {
            row.AddChild(this.MakeButton(ManageView.DisableLabel, () => { void this.Run(() => this.client.DisableAccount(this.name, a.principalId)) }))
        }
        return row
    }

    private GrantRow(g: GrantDto): StackPanel
    {
        const row = new StackPanel()
        row.Orientation = Orientation.Horizontal
        const text = new TextBlock()
        text.Text = g.role + ManageView.OnKeyword + g.resourceKind + ManageView.PathJoin + g.resourcePath.join(ManageView.PathSeparator)
        row.AddChild(text)
        row.AddChild(this.MakeButton(ManageView.RevokeLabel, () =>
        {
            void this.Run(() => this.client.RevokeRole(this.name, { subject: g.subject, role: g.role, resourceKind: g.resourceKind, resourcePath: g.resourcePath }))
        }))
        return row
    }

    private Clear(panel: StackPanel): void
    {
        for (const child of [...panel.Children])
        {
            panel.RemoveChild(child)
        }
    }

    private Heading(text: string): TextBlock
    {
        const heading = new TextBlock()
        heading.Text = text
        return heading
    }

    private async SubmitAccount(): Promise<void>
    {
        await this.Run(() => this.client.CreateAccount(this.name, this.emailBox.Text.trim(), this.principalBox.Text.trim(), this.passwordBox.Text))
    }

    private async SubmitGrant(): Promise<void>
    {
        const role = this.roleBox.SelectedItem as RoleOption | undefined
        if (role === undefined)
        {
            this.message.Text = PortalViewBase.ErrorPrefix + ManageView.NoRole
            return
        }
        const kind = this.kindBox.Text.trim()
        const path = this.pathBox.Text.split(ManageView.PathSeparator).map(s => s.trim()).filter(s => s.length > 0)
        await this.Run(() => this.client.GrantRole(this.name, {
            subject: this.subjectBox.Text.trim(),
            role: role.Label,
            resourceKind: kind.length > 0 ? kind : ManageView.DefaultResourceKind,
            resourcePath: path
        }))
    }

    private async SaveModel(): Promise<void>
    {
        if (this.config === undefined)
        {
            return
        }
        let parsed: unknown
        try
        {
            parsed = JSON.parse(this.modelBox.Text)
        }
        catch (e)
        {
            this.ShowMessage(e)
            return
        }
        const next: IdentityConfigDto = { ...this.config, securityModel: parsed }
        this.lastModelText = this.modelBox.Text
        await this.Run(() => this.client.SetConfig(this.name, next))
    }
}
