import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { AdminCapability } from '../../shell/admin-capability.js'
import type { TenantSessionService } from '../../shell/tenant-session-service.js'
import type { AccountDto, GrantDto } from '../../tenant-types.js'
import { CreateAccountDialogViewModel } from './create-account-dialog-view-model.js'
import { EnvironmentScopedPageViewModel } from './environment-scoped-page-view-model.js'
import type { UsersAccessSectionService } from './users-access-section-service.js'

// Account status as shown in the tables.
export enum AccountStatus
{
    Active,
    Disabled,
}

// The labels shared by the accounts table and an account's detail.
export class AccountLabels
{
    private static readonly ActiveLabel = 'Active'
    private static readonly DisabledLabel = 'Disabled'
    private static readonly RoleSeparator = ', '
    private static readonly NoRoles = 'No roles'

    public static StatusOf(account: AccountDto): AccountStatus
    {
        return account.disabled ? AccountStatus.Disabled : AccountStatus.Active
    }

    public static StatusLabel(status: AccountStatus): string
    {
        return status === AccountStatus.Active ? AccountLabels.ActiveLabel : AccountLabels.DisabledLabel
    }

    // The distinct role names granted to `principalId`, comma-joined.
    public static RolesText(principalId: string, grants: readonly GrantDto[]): string
    {
        const roles = Array.from(new Set(grants.filter(g => g.subject === principalId).map(g => g.role)))
        return roles.length === 0 ? AccountLabels.NoRoles : roles.join(AccountLabels.RoleSeparator)
    }
}

// One accounts-table line; the email opens the account's detail.
export class AccountRowViewModel extends Observable
{
    private readonly status: AccountStatus
    private readonly rolesText: string

    public constructor(private readonly account: AccountDto, grants: readonly GrantDto[], private readonly isYou: boolean,
        private readonly openCommand: RelayCommand)
    {
        super()
        this.status = AccountLabels.StatusOf(account)
        this.rolesText = AccountLabels.RolesText(account.principalId, grants)
    }

    public get Email(): string
    {
        return this.account.email
    }

    public get PrincipalId(): string
    {
        return this.account.principalId
    }

    public get RolesText(): string
    {
        return this.rolesText
    }

    // The signed-in operator's own account.
    public get IsYou(): boolean
    {
        return this.isYou
    }

    public get Status(): AccountStatus
    {
        return this.status
    }

    public get StatusLabel(): string
    {
        return AccountLabels.StatusLabel(this.status)
    }

    public get IsActive(): boolean
    {
        return this.status === AccountStatus.Active
    }

    public get IsDisabled(): boolean
    {
        return this.status === AccountStatus.Disabled
    }

    public get OpenCommand(): RelayCommand
    {
        return this.openCommand
    }
}

// The Users tab: the accounts of the selected environment, with their roles,
// and Create account.
export class UsersTabViewModel extends EnvironmentScopedPageViewModel
{
    private static readonly RowsProperty = 'Rows'
    private static readonly CreateAccountTitle = 'Create account'

    private rows = new ObservableCollection<AccountRowViewModel>()
    private readonly createAccountCommand: RelayCommand

    public constructor(session: TenantSessionService, private readonly section: UsersAccessSectionService)
    {
        super(session)
        this.createAccountCommand = this.MutatingCommand(AdminCapability.Access, () => this.CreateAccount(),
            () => this.Environment !== undefined)
    }

    public get Rows(): ObservableCollection<AccountRowViewModel>
    {
        return this.rows
    }

    public get CreateAccountCommand(): RelayCommand
    {
        return this.createAccountCommand
    }

    protected override get PageCapability(): AdminCapability | undefined
    {
        return AdminCapability.Access
    }

    // The previous environment's rows go at once: they open accounts of that
    // environment and must not stay clickable while the new one loads.
    protected override OnEnvironmentChanged(): void
    {
        super.OnEnvironmentChanged()
        this.ReplaceRows(new ObservableCollection<AccountRowViewModel>())
        this.RaiseMutatingCommandsChanged()
    }

    protected override async LoadFor(environment: string): Promise<boolean>
    {
        const generation = this.LoadGeneration
        const snapshot = await this.Session.Client.GetAdminSnapshot(environment)
        if (generation !== this.LoadGeneration)
        {
            return false
        }
        const me = this.Session.PrincipalId
        const rows = new ObservableCollection<AccountRowViewModel>()
        for (const account of snapshot.accounts)
        {
            const open = new RelayCommand(() => this.section.OpenAccount(environment, account.principalId))
            rows.Add(new AccountRowViewModel(account, snapshot.grants, account.principalId === me, open))
        }
        this.ReplaceRows(rows)
        return rows.Count > 0
    }

    private ReplaceRows(rows: ObservableCollection<AccountRowViewModel>): void
    {
        const old = this.rows
        this.rows = rows
        this.RaisePropertyChanged(UsersTabViewModel.RowsProperty, old, rows)
    }

    private async CreateAccount(): Promise<void>
    {
        const environment = this.Environment
        if (environment === undefined)
        {
            return
        }
        await this.OpenCreate(this.section.Dialogs, d => new CreateAccountDialogViewModel(this.Session, d, environment),
            UsersTabViewModel.CreateAccountTitle, async () => { await this.Refresh() })
    }
}
