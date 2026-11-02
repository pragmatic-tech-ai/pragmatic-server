import { ObservableCollection } from '@pragmatic-tech-ai/mural/runtime'
import type { DialogService } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import { AdminCapability } from '../../shell/admin-capability.js'
import type { OptionViewModel } from '../../shell/option-view-model.js'
import { TenantDialogViewModel } from '../../shell/tenant-dialog-view-model.js'
import type { TenantSessionService } from '../../shell/tenant-session-service.js'
import type { TokenIssuedDto } from '../../tenant-types.js'
import { TokenDurations, type TokenDuration } from './token-duration.js'

// Issue an API token in one environment: who it acts as, its scopes (space-
// or comma-separated, at least one) and how long it lasts. Resolves with the
// issued token, which the caller hands straight to the one-time reveal page;
// this dialog keeps no copy of it.
export class IssueTokenDialogViewModel extends TenantDialogViewModel<TokenIssuedDto>
{
    private static readonly PrincipalIdProperty = 'PrincipalId'
    private static readonly ScopesProperty = 'Scopes'
    private static readonly ScopesErrorTextProperty = 'ScopesErrorText'
    private static readonly SelectedDurationProperty = 'SelectedDuration'
    private static readonly ScopeSplitter = /[\s,]+/
    private static readonly ScopesRequiredMessage = 'At least one scope is required.'

    private principalId: string
    private scopes = ''
    private scopesTouched = false
    private readonly durations: ObservableCollection<OptionViewModel<TokenDuration>>
    private selectedDuration: OptionViewModel<TokenDuration> | undefined

    public constructor(session: TenantSessionService, dialogs: DialogService, private readonly environment: string, principalId: string = '')
    {
        super(session, dialogs, AdminCapability.Access)
        this.principalId = principalId
        this.durations = new ObservableCollection<OptionViewModel<TokenDuration>>()
        for (const option of TokenDurations.Options())
        {
            this.durations.Add(option)
            if (option.Value === TokenDurations.Default)
            {
                this.selectedDuration = option
            }
        }
    }

    public get Environment(): string
    {
        return this.environment
    }

    public get PrincipalId(): string
    {
        return this.principalId
    }

    public set PrincipalId(value: string)
    {
        this.SetField(IssueTokenDialogViewModel.PrincipalIdProperty, this.principalId, value, v => { this.principalId = v })
    }

    public get Scopes(): string
    {
        return this.scopes
    }

    public set Scopes(value: string)
    {
        const oldError = this.ScopesErrorText
        this.scopesTouched = true
        this.SetField(IssueTokenDialogViewModel.ScopesProperty, this.scopes, value, v => { this.scopes = v })
        this.RaisePropertyChanged(IssueTokenDialogViewModel.ScopesErrorTextProperty, oldError, this.ScopesErrorText)
    }

    // The scopes as sent: split on spaces and commas, blanks dropped.
    public get ParsedScopes(): string[]
    {
        return this.scopes.split(IssueTokenDialogViewModel.ScopeSplitter).filter(s => s.length > 0)
    }

    // Why the typed scopes are not accepted; '' until typed, or while valid.
    public get ScopesErrorText(): string
    {
        return this.scopesTouched && this.ParsedScopes.length === 0 ? IssueTokenDialogViewModel.ScopesRequiredMessage : ''
    }

    public get Durations(): ObservableCollection<OptionViewModel<TokenDuration>>
    {
        return this.durations
    }

    public get SelectedDuration(): OptionViewModel<TokenDuration> | undefined
    {
        return this.selectedDuration
    }

    public set SelectedDuration(value: OptionViewModel<TokenDuration> | undefined)
    {
        this.SetField(IssueTokenDialogViewModel.SelectedDurationProperty, this.selectedDuration, value, v => { this.selectedDuration = v })
    }

    protected override get CanConfirm(): boolean
    {
        return this.principalId.trim().length > 0 && this.ParsedScopes.length > 0 && this.selectedDuration !== undefined
    }

    protected override async SubmitCore(): Promise<TokenIssuedDto>
    {
        const scopes = this.ParsedScopes
        if (scopes.length === 0)
        {
            throw new Error(IssueTokenDialogViewModel.ScopesRequiredMessage)
        }
        const duration = this.selectedDuration?.Value ?? TokenDurations.Default
        return await this.Session.Client.IssueToken(this.environment, {
            principalId: this.principalId.trim(), scopes, expiresInSeconds: TokenDurations.SecondsFor(duration),
        })
    }
}
