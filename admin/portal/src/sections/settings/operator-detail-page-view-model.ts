import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { OperatorContext } from '../../operator-context.js'
import type { OperatorSummaryDto } from '../../portal-types.js'
import { OptionViewModel } from '../../shell/option-view-model.js'
import { PortalPageViewModel } from '../../shell/portal-page-view-model.js'
import type { PortalSessionService } from '../../shell/portal-session-service.js'
import type { SettingsSectionService } from './settings-section-service.js'

// One operator, opened from the roster: change their role, disable or enable
// the account, revoke their sessions, or reset their password. Revoke and
// reset ask for the email first; a reset's new password is shown once on a
// reveal page. All of it is Operator-only: an Observer never reads the roster,
// so this page doesn't load it for them either.
export class OperatorDetailPageViewModel extends PortalPageViewModel
{
    private static readonly NotFoundTemplate = 'Operator {email} was not found.'
    private static readonly EmailToken = '{email}'
    private static readonly ActiveLabel = 'Active'
    private static readonly DisabledLabel = 'Disabled'
    private static readonly DisableLabel = 'Disable operator'
    private static readonly EnableLabel = 'Enable operator'
    private static readonly RevokeTitle = 'Revoke this operator\'s sessions?'
    private static readonly RevokeMessage = 'Signs the operator out everywhere. They can sign in again with their password.'
    private static readonly RevokeLabel = 'Revoke sessions'
    private static readonly ResetTitle = 'Reset this operator\'s password?'
    private static readonly ResetMessage = 'Their current password stops working. The new password is shown once, for you to hand over.'
    private static readonly ResetLabel = 'Reset password'
    private static readonly NoText = ''
    private static readonly RoleLabelProperty = 'RoleLabel'
    private static readonly StatusLabelProperty = 'StatusLabel'
    private static readonly ToggleDisabledLabelProperty = 'ToggleDisabledLabel'
    private static readonly SelectedRoleProperty = 'SelectedRole'

    private operator: OperatorSummaryDto | undefined
    private readonly roles = new ObservableCollection<OptionViewModel<string>>()
    private selectedRole: OptionViewModel<string> | undefined
    private readonly changeRoleCommand: RelayCommand
    private readonly toggleDisabledCommand: RelayCommand
    private readonly revokeSessionsCommand: RelayCommand
    private readonly resetPasswordCommand: RelayCommand
    private readonly backCommand: RelayCommand

    public constructor(session: PortalSessionService, private readonly section: SettingsSectionService, public readonly Email: string)
    {
        super(session)
        this.roles.Add(new OptionViewModel(OperatorContext.FullWireRole, OperatorContext.RoleLabel(OperatorContext.FullWireRole)))
        this.roles.Add(new OptionViewModel(OperatorContext.ReadOnlyWireRole, OperatorContext.RoleLabel(OperatorContext.ReadOnlyWireRole)))
        const loaded = (): boolean => this.operator !== undefined
        this.changeRoleCommand = this.MutatingCommand(() => this.ChangeRole(),
            () => loaded() && this.selectedRole !== undefined && this.selectedRole.Value !== this.operator?.role)
        this.toggleDisabledCommand = this.MutatingCommand(() => this.ToggleDisabled(), loaded)
        this.revokeSessionsCommand = this.MutatingCommand(() => this.RevokeSessions(), loaded)
        this.resetPasswordCommand = this.MutatingCommand(() => this.ResetPassword(), loaded)
        this.backCommand = new RelayCommand(() => { void this.section.BackAndRefresh() })
    }

    public get RoleLabel(): string
    {
        return this.operator === undefined ? OperatorDetailPageViewModel.NoText : OperatorContext.RoleLabel(this.operator.role)
    }

    public get StatusLabel(): string
    {
        if (this.operator === undefined)
        {
            return OperatorDetailPageViewModel.NoText
        }
        return this.operator.disabled === true ? OperatorDetailPageViewModel.DisabledLabel : OperatorDetailPageViewModel.ActiveLabel
    }

    // The toggle's label: Enable for a disabled account, Disable otherwise.
    public get ToggleDisabledLabel(): string
    {
        return this.operator?.disabled === true ? OperatorDetailPageViewModel.EnableLabel : OperatorDetailPageViewModel.DisableLabel
    }

    public get Roles(): ObservableCollection<OptionViewModel<string>>
    {
        return this.roles
    }

    public get SelectedRole(): OptionViewModel<string> | undefined
    {
        return this.selectedRole
    }

    public set SelectedRole(value: OptionViewModel<string> | undefined)
    {
        const old = this.selectedRole
        if (old === value)
        {
            return
        }
        this.selectedRole = value
        this.RaisePropertyChanged(OperatorDetailPageViewModel.SelectedRoleProperty, old, value)
        this.changeRoleCommand.RaiseCanExecuteChanged()
    }

    // Back to the roster, reloaded: a role or account change here changed it.
    public get BackCommand(): RelayCommand
    {
        return this.backCommand
    }

    public get ChangeRoleCommand(): RelayCommand
    {
        return this.changeRoleCommand
    }

    public get ToggleDisabledCommand(): RelayCommand
    {
        return this.toggleDisabledCommand
    }

    public get RevokeSessionsCommand(): RelayCommand
    {
        return this.revokeSessionsCommand
    }

    public get ResetPasswordCommand(): RelayCommand
    {
        return this.resetPasswordCommand
    }

    // The roster is Operator-only (the control plane refuses it to an
    // Observer), so an Observer's page shows the email and its denied reason.
    protected override async LoadCore(): Promise<boolean>
    {
        if (!this.Session.CanMutate)
        {
            return true
        }
        const generation = this.LoadGeneration
        const roster = await this.Session.Client.ListOperators()
        if (generation !== this.LoadGeneration)
        {
            return false
        }
        const found = roster.find(o => o.email === this.Email)
        if (found === undefined)
        {
            throw new Error(OperatorDetailPageViewModel.NotFoundTemplate.replace(OperatorDetailPageViewModel.EmailToken, this.Email))
        }
        this.Apply(found)
        return true
    }

    private Apply(next: OperatorSummaryDto): void
    {
        const P = OperatorDetailPageViewModel
        const role = this.RoleLabel
        const status = this.StatusLabel
        const toggle = this.ToggleDisabledLabel
        this.operator = { ...next }
        this.RaisePropertyChanged(P.RoleLabelProperty, role, this.RoleLabel)
        this.RaisePropertyChanged(P.StatusLabelProperty, status, this.StatusLabel)
        this.RaisePropertyChanged(P.ToggleDisabledLabelProperty, toggle, this.ToggleDisabledLabel)
        this.SelectedRole = this.roles.ToArray().find(r => r.Value === next.role)
        this.changeRoleCommand.RaiseCanExecuteChanged()
        this.toggleDisabledCommand.RaiseCanExecuteChanged()
        this.revokeSessionsCommand.RaiseCanExecuteChanged()
        this.resetPasswordCommand.RaiseCanExecuteChanged()
    }

    private async ChangeRole(): Promise<void>
    {
        const current = this.operator
        const role = this.selectedRole?.Value
        if (current === undefined || role === undefined)
        {
            return
        }
        await this.Session.Client.SetOperatorRole(this.Email, role)
        this.Apply({ ...current, role })
    }

    private async ToggleDisabled(): Promise<void>
    {
        const current = this.operator
        if (current === undefined)
        {
            return
        }
        const disabled = current.disabled !== true
        await this.Session.Client.SetOperatorDisabled(this.Email, disabled)
        this.Apply({ ...current, disabled })
    }

    private RevokeSessions(): Promise<void>
    {
        return this.ConfirmByName(this.section.Dialogs, {
            Expected: this.Email,
            Title: OperatorDetailPageViewModel.RevokeTitle,
            Message: OperatorDetailPageViewModel.RevokeMessage,
            ConfirmLabel: OperatorDetailPageViewModel.RevokeLabel,
            Action: () => this.Session.Client.RevokeOperatorSessions(this.Email),
            OnConfirmed: () => Promise.resolve(),
        })
    }

    // The new password passes straight from the reset's response to the
    // reveal page; this page never holds it.
    private ResetPassword(): Promise<void>
    {
        let reveal: (() => void) | undefined
        return this.ConfirmByName(this.section.Dialogs, {
            Expected: this.Email,
            Title: OperatorDetailPageViewModel.ResetTitle,
            Message: OperatorDetailPageViewModel.ResetMessage,
            ConfirmLabel: OperatorDetailPageViewModel.ResetLabel,
            Action: async () =>
            {
                const reset = await this.Session.Client.ResetOperatorPassword(this.Email)
                reveal = () => this.section.ShowResetPassword(this.Email, reset.password)
            },
            OnConfirmed: async () =>
            {
                reveal?.()
                reveal = undefined
            },
        })
    }
}
