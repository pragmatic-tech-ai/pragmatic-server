import { ObservableCollection, type RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { AdminCapabilities, AdminCapability } from '../../shell/admin-capability.js'
import { PendingWork } from '../../shell/holds-pending-work.js'
import { OptionViewModel } from '../../shell/option-view-model.js'
import { TenantPageViewModel } from '../../shell/tenant-page-view-model.js'
import type { TenantSessionService } from '../../shell/tenant-session-service.js'
import { TenantApiError } from '../../tenant-api-client.js'
import type { EnvironmentScopedPageViewModel } from './environment-scoped-page-view-model.js'
import { SecurityModelEditorViewModel } from './security-model/security-model-editor-view-model.js'
import { TokensTabViewModel } from './tokens-tab-view-model.js'
import { UsersTabViewModel } from './users-tab-view-model.js'
import type { UsersAccessSectionService } from './users-access-section-service.js'

// The Users & Access page's tabs.
export enum UsersAccessTab
{
    Users,
    Roles,
    Tokens,
}

// Users & Access: one page over the environment picked in its Environment
// ComboBox, with three tabs (Users, Roles & permissions, Tokens). Each tab is
// an EnvironmentScopedPageViewModel rendered through CurrentTab by its own
// template. A tab loads the first time it is shown; a tab that has loaded
// follows every later environment change. Switching environment while the
// security-model editor holds unsaved changes asks first; declined, the
// picker snaps back. Without the Manage users & access permission the whole
// page is Denied and nothing loads.
export class UsersAccessPageViewModel extends TenantPageViewModel
{
    private static readonly EnvironmentsProperty = 'Environments'
    private static readonly SelectedEnvironmentProperty = 'SelectedEnvironment'
    private static readonly SelectedTabProperty = 'SelectedTab'
    private static readonly CurrentTabProperty = 'CurrentTab'
    private static readonly IsUsersTabProperty = 'IsUsersTab'
    private static readonly IsTokensTabProperty = 'IsTokensTab'
    private static readonly UsersLabel = 'Users'
    private static readonly RolesLabel = 'Roles & permissions'
    private static readonly TokensLabel = 'Tokens'
    private static readonly DeniedTemplate = 'This needs {need}. Ask {whom}. Nothing here was changed.'
    private static readonly NeedToken = '{need}'
    private static readonly WhomToken = '{whom}'
    private static readonly DiscardTitle = 'Discard unsaved changes'
    private static readonly DiscardMessage = 'Discard unsaved changes to the security model?'
    private static readonly DiscardConsequences = [
        'Your edits to roles and permissions in this environment are lost.',
        'The other environment opens with its saved security model.',
    ] as const
    private static readonly DiscardLabel = 'Discard changes'

    private readonly usersTab: UsersTabViewModel
    private readonly editor: SecurityModelEditorViewModel
    private readonly tokensTab: TokensTabViewModel
    private readonly tabLabels = new ObservableCollection<string>()
    private tab = UsersAccessTab.Users
    private environments = new ObservableCollection<OptionViewModel<string>>()
    private selectedEnvironment: OptionViewModel<string> | undefined
    private confirmingSwitch = false

    public constructor(session: TenantSessionService, private readonly section: UsersAccessSectionService)
    {
        super(session)
        this.usersTab = new UsersTabViewModel(session, section)
        this.editor = new SecurityModelEditorViewModel(session, section)
        this.tokensTab = new TokensTabViewModel(session, section)
        for (const tab of [UsersAccessTab.Users, UsersAccessTab.Roles, UsersAccessTab.Tokens])
        {
            this.tabLabels.Add(UsersAccessPageViewModel.LabelOf(tab))
        }
    }

    public get UsersTab(): UsersTabViewModel
    {
        return this.usersTab
    }

    public get SecurityModelEditor(): SecurityModelEditorViewModel
    {
        return this.editor
    }

    public get TokensTab(): TokensTabViewModel
    {
        return this.tokensTab
    }

    // Why the whole page is denied, with who to ask.
    public get DeniedPageText(): string
    {
        const P = UsersAccessPageViewModel
        return P.DeniedTemplate
            .replace(P.NeedToken, AdminCapabilities.NameOf(AdminCapability.Access))
            .replace(P.WhomToken, this.Session.OwnerContact)
    }

    public get Environments(): ObservableCollection<OptionViewModel<string>>
    {
        return this.environments
    }

    public get SelectedEnvironment(): OptionViewModel<string> | undefined
    {
        return this.selectedEnvironment
    }

    // Picks an environment. With unsaved security-model changes it asks
    // first; declined (or while that question is open) the picker snaps back.
    public set SelectedEnvironment(value: OptionViewModel<string> | undefined)
    {
        if (value === undefined || value === this.selectedEnvironment)
        {
            return
        }
        if (this.confirmingSwitch)
        {
            this.SnapBack(value)
            return
        }
        if (PendingWork.IsHeldBy(this.editor))
        {
            void this.ConfirmSwitch(value)
            return
        }
        this.ApplyEnvironment(value)
    }

    // The selected environment's name; undefined when there is none.
    public get EnvironmentName(): string | undefined
    {
        return this.selectedEnvironment?.Value
    }

    public get TabLabels(): ObservableCollection<string>
    {
        return this.tabLabels
    }

    public get Tab(): UsersAccessTab
    {
        return this.tab
    }

    // The selected tab's label (the SegmentedButton's two-way selection).
    public get SelectedTab(): string
    {
        return UsersAccessPageViewModel.LabelOf(this.tab)
    }

    public set SelectedTab(label: string)
    {
        const tab = UsersAccessPageViewModel.TabOf(label)
        if (tab !== undefined)
        {
            void this.ShowTab(tab)
        }
    }

    // The tab on screen, rendered by its implicit template.
    public get CurrentTab(): EnvironmentScopedPageViewModel
    {
        return this.TabViewModel(this.tab)
    }

    public get IsUsersTab(): boolean
    {
        return this.tab === UsersAccessTab.Users
    }

    public get IsTokensTab(): boolean
    {
        return this.tab === UsersAccessTab.Tokens
    }

    // The header's primary action on the Users tab.
    public get CreateAccountCommand(): RelayCommand
    {
        return this.usersTab.CreateAccountCommand
    }

    // The header's primary action on the Tokens tab.
    public get IssueTokenCommand(): RelayCommand
    {
        return this.tokensTab.IssueTokenCommand
    }

    // Shows a tab, loading it for the selected environment the first time
    // (or when the environment changed since it last loaded). A draft in the
    // security-model editor survives switching tabs.
    public async ShowTab(tab: UsersAccessTab): Promise<void>
    {
        if (tab !== this.tab)
        {
            const P = UsersAccessPageViewModel
            const before = [this.SelectedTab, this.CurrentTab, this.IsUsersTab, this.IsTokensTab] as const
            this.tab = tab
            this.RaisePropertyChanged(P.SelectedTabProperty, before[0], this.SelectedTab)
            this.RaisePropertyChanged(P.CurrentTabProperty, before[1], this.CurrentTab)
            this.RaisePropertyChanged(P.IsUsersTabProperty, before[2], this.IsUsersTab)
            this.RaisePropertyChanged(P.IsTokensTabProperty, before[3], this.IsTokensTab)
        }
        await this.SyncTabs(false)
    }

    // Shows the Tokens tab, reloaded (after a token's value was revealed).
    public async ShowTokens(): Promise<void>
    {
        // Already loaded for this environment: showing it does not reload it.
        const loaded = this.EnvironmentName !== undefined && this.tokensTab.Environment === this.EnvironmentName
        await this.ShowTab(UsersAccessTab.Tokens)
        if (loaded)
        {
            await this.tokensTab.Refresh()
        }
    }

    protected override get PageCapability(): AdminCapability | undefined
    {
        return AdminCapability.Access
    }

    // Denied without the permission (nothing loads); Empty without
    // environments; otherwise the picker fills (keeping the selection when it
    // still exists) and the current tab reloads, unless it holds unsaved work.
    protected override async LoadCore(): Promise<boolean>
    {
        if (!this.Session.Can(AdminCapability.Access))
        {
            throw new TenantApiError(TenantApiError.ForbiddenStatus, this.DeniedPageText)
        }
        const generation = this.LoadGeneration
        const environments = await this.Session.Client.ListEnvironments()
        if (generation !== this.LoadGeneration)
        {
            return false
        }
        this.ApplyEnvironments(environments.map(e => e.name))
        if (this.selectedEnvironment === undefined)
        {
            return false
        }
        await this.SyncTabs(true)
        return true
    }

    // Points the tabs at the selected environment: the current tab always
    // (reloaded when asked and it holds no unsaved work), the others only
    // once they have loaded before.
    private async SyncTabs(reloadCurrent: boolean): Promise<void>
    {
        const environment = this.EnvironmentName
        if (environment === undefined)
        {
            return
        }
        const current = this.CurrentTab
        const loads: Promise<void>[] = []
        for (const tab of [this.usersTab, this.editor, this.tokensTab])
        {
            if (tab.Environment !== environment && (tab === current || tab.Environment !== undefined))
            {
                loads.push(tab.UseEnvironment(environment))
            }
            else if (tab === current && reloadCurrent && !PendingWork.IsHeldBy(tab))
            {
                loads.push(tab.Refresh())
            }
        }
        await Promise.all(loads)
    }

    // A fresh option collection each load (a realized ComboBox ignores
    // in-place changes); the selection carries over by name, else the first.
    private ApplyEnvironments(names: readonly string[]): void
    {
        const P = UsersAccessPageViewModel
        const options = new ObservableCollection<OptionViewModel<string>>()
        for (const name of names)
        {
            options.Add(new OptionViewModel(name, name))
        }
        const keep = this.selectedEnvironment?.Value
        const all = options.ToArray()
        const selected = all.find(o => o.Value === keep) ?? all[0]
        const oldOptions = this.environments
        const oldSelected = this.selectedEnvironment
        this.environments = options
        this.selectedEnvironment = selected
        this.RaisePropertyChanged(P.EnvironmentsProperty, oldOptions, options)
        this.RaisePropertyChanged(P.SelectedEnvironmentProperty, oldSelected, selected)
    }

    private ApplyEnvironment(value: OptionViewModel<string>): void
    {
        const old = this.selectedEnvironment
        this.selectedEnvironment = value
        this.RaisePropertyChanged(UsersAccessPageViewModel.SelectedEnvironmentProperty, old, value)
        void this.SyncTabs(false)
    }

    private async ConfirmSwitch(value: OptionViewModel<string>): Promise<void>
    {
        const P = UsersAccessPageViewModel
        let confirmed = false
        this.confirmingSwitch = true
        try
        {
            await this.Guard(() => this.Confirm(this.section.Dialogs, {
                Capability: AdminCapability.Access, Title: P.DiscardTitle, Message: P.DiscardMessage,
                Consequences: P.DiscardConsequences, ConfirmLabel: P.DiscardLabel,
                Action: async () => { },
                OnConfirmed: async () => { confirmed = true },
            }))
        }
        finally
        {
            this.confirmingSwitch = false
        }
        if (confirmed)
        {
            this.ApplyEnvironment(value)
        }
        else
        {
            this.SnapBack(value)
        }
    }

    // Re-reads the selection so the picker shows the kept environment again.
    private SnapBack(attempted: OptionViewModel<string>): void
    {
        this.RaisePropertyChanged(UsersAccessPageViewModel.SelectedEnvironmentProperty, attempted, this.selectedEnvironment)
    }

    private TabViewModel(tab: UsersAccessTab): EnvironmentScopedPageViewModel
    {
        switch (tab)
        {
            case UsersAccessTab.Users:
                return this.usersTab
            case UsersAccessTab.Roles:
                return this.editor
            case UsersAccessTab.Tokens:
                return this.tokensTab
        }
    }

    private static LabelOf(tab: UsersAccessTab): string
    {
        switch (tab)
        {
            case UsersAccessTab.Users:
                return UsersAccessPageViewModel.UsersLabel
            case UsersAccessTab.Roles:
                return UsersAccessPageViewModel.RolesLabel
            case UsersAccessTab.Tokens:
                return UsersAccessPageViewModel.TokensLabel
        }
    }

    private static TabOf(label: string): UsersAccessTab | undefined
    {
        const all = [UsersAccessTab.Users, UsersAccessTab.Roles, UsersAccessTab.Tokens]
        return all.find(t => UsersAccessPageViewModel.LabelOf(t) === label)
    }
}
