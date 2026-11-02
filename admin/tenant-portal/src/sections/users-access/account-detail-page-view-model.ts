import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { AdminCapability } from '../../shell/admin-capability.js'
import { OptionViewModel } from '../../shell/option-view-model.js'
import { TenantPageViewModel } from '../../shell/tenant-page-view-model.js'
import type { TenantSessionService } from '../../shell/tenant-session-service.js'
import { TenantRole, type AccountDto, type GrantDto } from '../../tenant-types.js'
import { IssueTokenDialogViewModel } from './issue-token-dialog-view-model.js'
import { AccountLabels, AccountStatus } from './users-tab-view-model.js'
import type { UsersAccessSectionService } from './users-access-section-service.js'

// One of an account's grants, with its Revoke.
export class GrantRowViewModel extends Observable
{
    private static readonly PathSeparator = ' / '

    public constructor(private readonly grant: GrantDto, private readonly revokeCommand: RelayCommand)
    {
        super()
    }

    public get Role(): string
    {
        return this.grant.role
    }

    // Where the grant applies: its resource kind, then the path below it.
    public get ResourceText(): string
    {
        return [this.grant.resourceKind, ...this.grant.resourcePath].join(GrantRowViewModel.PathSeparator)
    }

    public get RevokeCommand(): RelayCommand
    {
        return this.revokeCommand
    }
}

// One account in one environment: its status, its grants (Revoke each),
// Grant role, Disable, and Issue token (prefilled with its principal id).
// Actions on the signed-in operator's own account carry a lockout warning.
// Every action needs the Manage users & access permission and reloads after.
export class AccountDetailPageViewModel extends TenantPageViewModel
{
    private static readonly AccountProperties = ['Email', 'StatusLabel', 'IsActive', 'IsDisabled', 'Grants', 'HasGrants', 'HasNoGrants'] as const
    private static readonly SelectedRoleProperty = 'SelectedRole'
    private static readonly IssueTokenTitle = 'Issue token'
    private static readonly RevokeTitle = 'Revoke role'
    private static readonly RevokeTemplate = 'Revoke {role} from {who}?'
    private static readonly RevokeLabel = 'Revoke role'
    private static readonly RevokeSelfWarning = 'This is your own grant; revoking it may reduce your access.'
    private static readonly DisableTitle = 'Disable account'
    private static readonly DisableTemplate = 'Disable {who}?'
    private static readonly DisableLabel = 'Disable account'
    private static readonly DisableConsequences = [
        "They are signed out everywhere and can't sign in.",
        'Their records and history stay. Their tokens stop working.',
    ] as const
    private static readonly DisableSelfWarning = 'This is your own account; disabling it will lock you out.'
    private static readonly RoleToken = '{role}'
    private static readonly EnvironmentToken = '{environment}'
    private static readonly RevokeConsequenceTemplate = '{who} loses the {role} role in {environment} at their next request.'
    private static readonly NoText = ''
    private static readonly WhoToken = '{who}'

    private account: AccountDto | undefined
    private grants = new ObservableCollection<GrantRowViewModel>()
    private readonly roles = new ObservableCollection<OptionViewModel<TenantRole>>()
    private selectedRole: OptionViewModel<TenantRole> | undefined
    private readonly backCommand: RelayCommand
    private readonly grantCommand: RelayCommand
    private readonly disableCommand: RelayCommand
    private readonly issueTokenCommand: RelayCommand

    public constructor(session: TenantSessionService, private readonly section: UsersAccessSectionService,
        private readonly environment: string, private readonly principalId: string)
    {
        super(session)
        for (const role of Object.values(TenantRole))
        {
            const option = new OptionViewModel(role, role)
            this.roles.Add(option)
            if (role === TenantRole.Viewer)
            {
                this.selectedRole = option
            }
        }
        this.backCommand = new RelayCommand(() => { void this.section.BackAndRefresh() })
        const loaded = (): boolean => this.account !== undefined
        this.grantCommand = this.MutatingCommand(AdminCapability.Access, () => this.Grant(),
            () => loaded() && this.selectedRole !== undefined)
        this.disableCommand = this.MutatingCommand(AdminCapability.Access, () => this.Disable(), () => this.IsActive)
        this.issueTokenCommand = this.MutatingCommand(AdminCapability.Access, () => this.IssueToken(), loaded)
    }

    public get Environment(): string
    {
        return this.environment
    }

    public get PrincipalId(): string
    {
        return this.principalId
    }

    public get Email(): string
    {
        return this.account?.email ?? AccountDetailPageViewModel.NoText
    }

    // The signed-in operator's own account.
    public get IsYou(): boolean
    {
        return this.principalId === this.Session.PrincipalId
    }

    public get StatusLabel(): string
    {
        return this.account === undefined ? AccountDetailPageViewModel.NoText : AccountLabels.StatusLabel(AccountLabels.StatusOf(this.account))
    }

    public get IsActive(): boolean
    {
        return this.account !== undefined && AccountLabels.StatusOf(this.account) === AccountStatus.Active
    }

    public get IsDisabled(): boolean
    {
        return this.account !== undefined && AccountLabels.StatusOf(this.account) === AccountStatus.Disabled
    }

    public get Grants(): ObservableCollection<GrantRowViewModel>
    {
        return this.grants
    }

    public get HasGrants(): boolean
    {
        return this.grants.Count > 0
    }

    public get HasNoGrants(): boolean
    {
        return !this.HasGrants
    }

    // The roles Grant role offers; Viewer by default.
    public get Roles(): ObservableCollection<OptionViewModel<TenantRole>>
    {
        return this.roles
    }

    public get SelectedRole(): OptionViewModel<TenantRole> | undefined
    {
        return this.selectedRole
    }

    public set SelectedRole(value: OptionViewModel<TenantRole> | undefined)
    {
        const old = this.selectedRole
        if (old === value)
        {
            return
        }
        this.selectedRole = value
        this.RaisePropertyChanged(AccountDetailPageViewModel.SelectedRoleProperty, old, value)
        this.RaiseMutatingCommandsChanged()
    }

    public get BackCommand(): RelayCommand
    {
        return this.backCommand
    }

    public get GrantCommand(): RelayCommand
    {
        return this.grantCommand
    }

    public get DisableCommand(): RelayCommand
    {
        return this.disableCommand
    }

    public get IssueTokenCommand(): RelayCommand
    {
        return this.issueTokenCommand
    }

    protected override get PageCapability(): AdminCapability | undefined
    {
        return AdminCapability.Access
    }

    // Empty when the account no longer exists in this environment.
    protected override async LoadCore(): Promise<boolean>
    {
        const generation = this.LoadGeneration
        const snapshot = await this.Session.Client.GetAdminSnapshot(this.environment)
        if (generation !== this.LoadGeneration)
        {
            return false
        }
        const account = snapshot.accounts.find(a => a.principalId === this.principalId)
        this.ClearRowCommands()
        const grants = new ObservableCollection<GrantRowViewModel>()
        for (const grant of snapshot.grants.filter(g => g.subject === this.principalId))
        {
            grants.Add(new GrantRowViewModel(grant, this.RowMutatingCommand(AdminCapability.Access, () => this.Revoke(grant))))
        }
        this.Apply(account, grants)
        return account !== undefined
    }

    private Apply(account: AccountDto | undefined, grants: ObservableCollection<GrantRowViewModel>): void
    {
        const P = AccountDetailPageViewModel
        const before = P.AccountProperties.map(name => this[name])
        this.account = account
        this.grants = grants
        P.AccountProperties.forEach((name, i) => this.RaisePropertyChanged(name, before[i], this[name]))
        this.RaiseMutatingCommandsChanged()
    }

    private async Grant(): Promise<void>
    {
        const role = this.selectedRole?.Value
        if (role === undefined)
        {
            return
        }
        await this.Session.Client.GrantRole(this.environment, { subject: this.principalId, role })
        await this.Refresh()
    }

    private async Revoke(grant: GrantDto): Promise<void>
    {
        const P = AccountDetailPageViewModel
        await this.Confirm(this.section.Dialogs, {
            Capability: AdminCapability.Access,
            Title: P.RevokeTitle,
            Message: P.RevokeTemplate.replace(P.RoleToken, grant.role).replace(P.WhoToken, this.Who),
            Consequences: [P.RevokeConsequenceTemplate.replace(P.WhoToken, this.Who).replace(P.RoleToken, grant.role)
                .replace(P.EnvironmentToken, this.environment)],
            Warning: this.IsYou ? P.RevokeSelfWarning : undefined,
            ConfirmLabel: P.RevokeLabel,
            Action: async () =>
            {
                await this.Session.Client.RevokeRole(this.environment, {
                    subject: grant.subject, role: grant.role, resourceKind: grant.resourceKind, resourcePath: grant.resourcePath,
                })
            },
            OnConfirmed: async () => { await this.Refresh() },
        })
    }

    private async Disable(): Promise<void>
    {
        const P = AccountDetailPageViewModel
        await this.Confirm(this.section.Dialogs, {
            Capability: AdminCapability.Access,
            Title: P.DisableTitle,
            Message: P.DisableTemplate.replace(P.WhoToken, this.Who),
            Consequences: P.DisableConsequences,
            Warning: this.IsYou ? P.DisableSelfWarning : undefined,
            ConfirmLabel: P.DisableLabel,
            Action: async () => { await this.Session.Client.DisableAccount(this.environment, this.principalId) },
            OnConfirmed: async () => { await this.Refresh() },
        })
    }

    private async IssueToken(): Promise<void>
    {
        const environment = this.environment
        await this.OpenCreate(this.section.Dialogs, d => new IssueTokenDialogViewModel(this.Session, d, environment, this.principalId),
            AccountDetailPageViewModel.IssueTokenTitle, async issued => { this.section.RevealToken(environment, issued) })
    }

    // How the account is named in confirms: its email, else its principal id.
    private get Who(): string
    {
        const email = this.Email
        return email.length > 0 ? email : this.principalId
    }
}
