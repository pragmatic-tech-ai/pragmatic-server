import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { SettingsViewModel, type OperatorRow } from '../../settings-view-model.js'
import { PortalPageViewModel } from '../../shell/portal-page-view-model.js'
import type { PortalSessionService } from '../../shell/portal-session-service.js'
import { InviteOperatorDialogViewModel } from './invite-operator-dialog-view-model.js'
import type { SettingsSectionService } from './settings-section-service.js'

// One operator on the roster: email, role and whether the account is enabled.
export class OperatorRowViewModel extends Observable
{
    private static readonly ActiveLabel = 'Active'
    private static readonly DisabledLabel = 'Disabled'

    public constructor(private readonly row: OperatorRow)
    {
        super()
    }

    public get Email(): string
    {
        return this.row.email
    }

    public get RoleLabel(): string
    {
        return this.row.roleLabel
    }

    public get StatusLabel(): string
    {
        return this.row.disabled ? OperatorRowViewModel.DisabledLabel : OperatorRowViewModel.ActiveLabel
    }
}

// Settings: the signed-in operator's profile (from the session) and the
// operator roster. Invite operator opens a dialog (Operator-only).
export class SettingsPageViewModel extends PortalPageViewModel
{
    private static readonly InviteTitle = 'Invite operator'
    private static readonly HasOperatorsProperty = 'HasOperators'
    private static readonly HasNoOperatorsProperty = 'HasNoOperators'

    private readonly operators = new ObservableCollection<OperatorRowViewModel>()
    private readonly inviteCommand: RelayCommand

    public constructor(session: PortalSessionService, private readonly section: SettingsSectionService)
    {
        super(session)
        this.inviteCommand = this.MutatingCommand(() => this.Invite())
    }

    public get Email(): string
    {
        return this.Session.Email
    }

    public get RoleLabel(): string
    {
        return this.Session.RoleLabel
    }

    public get Operators(): ObservableCollection<OperatorRowViewModel>
    {
        return this.operators
    }

    public get HasOperators(): boolean
    {
        return this.operators.Count > 0
    }

    public get HasNoOperators(): boolean
    {
        return this.operators.Count === 0
    }

    public get InviteCommand(): RelayCommand
    {
        return this.inviteCommand
    }

    // The profile always has content, so the page is Populated even with an empty roster.
    protected override async LoadCore(): Promise<boolean>
    {
        const generation = this.LoadGeneration
        const summaries = await this.Session.Client.ListOperators()
        if (generation !== this.LoadGeneration)
        {
            return false
        }
        const had = this.HasOperators
        const roster = new SettingsViewModel({ email: this.Email, roleLabel: this.RoleLabel })
        roster.Update(summaries)
        this.operators.Clear()
        for (const row of roster.Rows)
        {
            this.operators.Add(new OperatorRowViewModel(row))
        }
        this.RaisePropertyChanged(SettingsPageViewModel.HasOperatorsProperty, had, this.HasOperators)
        this.RaisePropertyChanged(SettingsPageViewModel.HasNoOperatorsProperty, !had, this.HasNoOperators)
        return true
    }

    private Invite(): Promise<void>
    {
        return this.OpenCreate(this.section.Dialogs, dialogs => new InviteOperatorDialogViewModel(this.Session, dialogs),
            SettingsPageViewModel.InviteTitle, () => this.Refresh())
    }
}
