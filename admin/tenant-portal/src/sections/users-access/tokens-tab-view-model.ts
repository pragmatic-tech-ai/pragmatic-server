import { ObservableCollection, type RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { AdminCapability } from '../../shell/admin-capability.js'
import { UtcText } from '../../shell/utc-text.js'
import type { TenantSessionService } from '../../shell/tenant-session-service.js'
import type { ServiceTokenSummaryDto } from '../../tenant-types.js'
import { EnvironmentScopedPageViewModel } from './environment-scoped-page-view-model.js'
import { IssueTokenDialogViewModel } from './issue-token-dialog-view-model.js'
import type { UsersAccessSectionService } from './users-access-section-service.js'

// A token's state: revoked wins over expired.
export enum TokenStatus
{
    Active,
    Expired,
    Revoked,
}

// One tokens-table line, with its Revoke.
export class TokenRowViewModel extends Observable
{
    private static readonly ActiveLabel = 'Active'
    private static readonly ExpiredLabel = 'Expired'
    private static readonly RevokedLabel = 'Revoked'
    private static readonly NeverText = 'Never'
    private static readonly ScopeSeparator = ', '

    private readonly status: TokenStatus

    public constructor(private readonly dto: ServiceTokenSummaryDto, private readonly revokeCommand: RelayCommand, now: number = Date.now())
    {
        super()
        this.status = TokenRowViewModel.StatusOf(dto, now)
    }

    public static StatusOf(dto: ServiceTokenSummaryDto, now: number): TokenStatus
    {
        if (dto.revoked)
        {
            return TokenStatus.Revoked
        }
        if (dto.expiresAt !== null && new Date(dto.expiresAt).getTime() < now)
        {
            return TokenStatus.Expired
        }
        return TokenStatus.Active
    }

    public get TokenRef(): string
    {
        return this.dto.tokenRef
    }

    // The principal the token acts as.
    public get Owner(): string
    {
        return this.dto.principalId
    }

    public get ScopesText(): string
    {
        return this.dto.scopes.join(TokenRowViewModel.ScopeSeparator)
    }

    public get ExpiresText(): string
    {
        return this.dto.expiresAt === null ? TokenRowViewModel.NeverText : UtcText.DateTime(this.dto.expiresAt)
    }

    public get Status(): TokenStatus
    {
        return this.status
    }

    public get StatusLabel(): string
    {
        switch (this.status)
        {
            case TokenStatus.Active:
                return TokenRowViewModel.ActiveLabel
            case TokenStatus.Expired:
                return TokenRowViewModel.ExpiredLabel
            case TokenStatus.Revoked:
                return TokenRowViewModel.RevokedLabel
        }
    }

    public get IsActive(): boolean
    {
        return this.status === TokenStatus.Active
    }

    public get IsExpired(): boolean
    {
        return this.status === TokenStatus.Expired
    }

    public get IsRevoked(): boolean
    {
        return this.status === TokenStatus.Revoked
    }

    public get RevokeCommand(): RelayCommand
    {
        return this.revokeCommand
    }
}

// The Tokens tab: the API tokens issued in the selected environment, Revoke
// (confirmed) per token, and Issue token, whose value shows once on a reveal
// page.
export class TokensTabViewModel extends EnvironmentScopedPageViewModel
{
    private static readonly RowsProperty = 'Rows'
    private static readonly IssueTokenTitle = 'Issue token'
    private static readonly RevokeTitle = 'Revoke service token'
    private static readonly RevokeMessage = 'This token stops working immediately. Anything using it will start failing.'
    private static readonly RevokeLabel = 'Revoke token'
    private static readonly RevokeConsequences: readonly string[] = [
        'Anything using this token starts failing at its next call.',
        'The token reference stays listed as Revoked.',
    ]

    private rows = new ObservableCollection<TokenRowViewModel>()
    private readonly issueTokenCommand: RelayCommand

    public constructor(session: TenantSessionService, private readonly section: UsersAccessSectionService)
    {
        super(session)
        this.issueTokenCommand = this.MutatingCommand(AdminCapability.Access, () => this.IssueToken(),
            () => this.Environment !== undefined)
    }

    public get Rows(): ObservableCollection<TokenRowViewModel>
    {
        return this.rows
    }

    public get IssueTokenCommand(): RelayCommand
    {
        return this.issueTokenCommand
    }

    protected override get PageCapability(): AdminCapability | undefined
    {
        return AdminCapability.Access
    }

    // The previous environment's rows go at once: their commands are bound to
    // that environment and must not stay clickable while the new one loads.
    protected override OnEnvironmentChanged(): void
    {
        super.OnEnvironmentChanged()
        this.ClearRowCommands()
        this.ReplaceRows(new ObservableCollection<TokenRowViewModel>())
        this.RaiseMutatingCommandsChanged()
    }

    protected override async LoadFor(environment: string): Promise<boolean>
    {
        const generation = this.LoadGeneration
        const tokens = await this.Session.Client.ListTokens(environment)
        if (generation !== this.LoadGeneration)
        {
            return false
        }
        this.ClearRowCommands()
        const rows = new ObservableCollection<TokenRowViewModel>()
        for (const token of tokens)
        {
            const revoke = this.RowMutatingCommand(AdminCapability.Access, () => this.Revoke(environment, token.tokenRef),
                () => !token.revoked)
            rows.Add(new TokenRowViewModel(token, revoke))
        }
        this.ReplaceRows(rows)
        return rows.Count > 0
    }

    private ReplaceRows(rows: ObservableCollection<TokenRowViewModel>): void
    {
        const old = this.rows
        this.rows = rows
        this.RaisePropertyChanged(TokensTabViewModel.RowsProperty, old, rows)
    }

    private async IssueToken(): Promise<void>
    {
        const environment = this.Environment
        if (environment === undefined)
        {
            return
        }
        await this.OpenCreate(this.section.Dialogs, d => new IssueTokenDialogViewModel(this.Session, d, environment),
            TokensTabViewModel.IssueTokenTitle, async issued => { this.section.RevealToken(environment, issued) })
    }

    private async Revoke(environment: string, tokenRef: string): Promise<void>
    {
        const T = TokensTabViewModel
        await this.Confirm(this.section.Dialogs, {
            Capability: AdminCapability.Access, Title: T.RevokeTitle, Message: T.RevokeMessage, ConfirmLabel: T.RevokeLabel,
            Consequences: T.RevokeConsequences,
            Action: async () => { await this.Session.Client.RevokeToken(environment, tokenRef) },
            OnConfirmed: async () => { await this.Refresh() },
        })
    }
}
