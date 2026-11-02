import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { PortalDates } from '../../portal-dates.js'
import type { ActivityDto } from '../../portal-types.js'
import { PortalPageViewModel } from '../../shell/portal-page-view-model.js'
import type { PortalSessionService } from '../../shell/portal-session-service.js'
import { ActivityActions, ActivityOutcome } from './activity-actions.js'
import type { ActivitySectionService } from './activity-section-service.js'

// One audited operator action, as the list and its detail show it.
export class ActivityEntryLabels
{
    private static readonly SucceededLabel = 'Succeeded'
    private static readonly RefusedTemplate = 'Refused ({status})'
    private static readonly FailedTemplate = 'Failed ({status})'
    private static readonly StatusToken = '{status}'

    public constructor(public readonly Entry: ActivityDto)
    {
    }

    public get WhenLabel(): string
    {
        return PortalDates.DateTimeLabel(this.Entry.at)
    }

    public get ActionLabel(): string
    {
        return ActivityActions.Label(this.Entry.method, this.Entry.path)
    }

    // Succeeded, or Refused / Failed with the response status.
    public get OutcomeLabel(): string
    {
        const status = String(this.Entry.status)
        switch (ActivityActions.Outcome(this.Entry.status))
        {
            case ActivityOutcome.Succeeded:
                return ActivityEntryLabels.SucceededLabel
            case ActivityOutcome.Refused:
                return ActivityEntryLabels.RefusedTemplate.replace(ActivityEntryLabels.StatusToken, status)
            case ActivityOutcome.Failed:
                return ActivityEntryLabels.FailedTemplate.replace(ActivityEntryLabels.StatusToken, status)
        }
    }
}

// One audit-log row; the action opens the entry's detail.
export class ActivityRowViewModel extends Observable
{
    private readonly labels: ActivityEntryLabels
    private readonly openCommand: RelayCommand

    public constructor(entry: ActivityDto, open: RelayCommand)
    {
        super()
        this.labels = new ActivityEntryLabels(entry)
        this.openCommand = new RelayCommand(() => open.Execute(this))
    }

    public get Entry(): ActivityDto
    {
        return this.labels.Entry
    }

    public get WhenLabel(): string
    {
        return this.labels.WhenLabel
    }

    public get Actor(): string
    {
        return this.labels.Entry.actor
    }

    public get ActionLabel(): string
    {
        return this.labels.ActionLabel
    }

    public get OutcomeLabel(): string
    {
        return this.labels.OutcomeLabel
    }

    public get OpenCommand(): RelayCommand
    {
        return this.openCommand
    }
}

// Activity: the audit log of operator actions, newest first as the control
// plane returns them. Read-only; a row opens the entry's detail.
export class ActivityPageViewModel extends PortalPageViewModel
{
    private readonly rows = new ObservableCollection<ActivityRowViewModel>()
    private readonly openCommand: RelayCommand

    public constructor(session: PortalSessionService, private readonly section: ActivitySectionService)
    {
        super(session)
        this.openCommand = new RelayCommand(row => this.Open(row))
    }

    public get Rows(): ObservableCollection<ActivityRowViewModel>
    {
        return this.rows
    }

    // Opens a row's entry detail; the parameter is the ActivityRowViewModel.
    public get OpenCommand(): RelayCommand
    {
        return this.openCommand
    }

    protected override async LoadCore(): Promise<boolean>
    {
        const generation = this.LoadGeneration
        const activity = await this.Session.Client.ListActivity()
        if (generation !== this.LoadGeneration)
        {
            return false
        }
        this.rows.Clear()
        for (const entry of activity)
        {
            this.rows.Add(new ActivityRowViewModel(entry, this.openCommand))
        }
        return this.rows.Count > 0
    }

    private Open(row: unknown): void
    {
        if (row instanceof ActivityRowViewModel)
        {
            this.section.OpenEntry(row.Entry)
        }
    }
}
