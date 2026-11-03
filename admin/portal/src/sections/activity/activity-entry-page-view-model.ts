import type { RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import type { ActivityDto } from '../../portal-types.js'
import { PortalPageViewModel } from '../../shell/portal-page-view-model.js'
import type { PortalSessionService } from '../../shell/portal-session-service.js'
import { ActivityEntryLabels } from './activity-page-view-model.js'
import type { ActivitySectionService } from './activity-section-service.js'

// One audit entry's detail: who did what and when, the request it records
// and its outcome. An audit entry never changes, so loading only shows it.
export class ActivityEntryPageViewModel extends PortalPageViewModel
{
    private static readonly NoNote = ''

    private readonly labels: ActivityEntryLabels

    public constructor(session: PortalSessionService, private readonly section: ActivitySectionService, entry: ActivityDto)
    {
        super(session)
        this.labels = new ActivityEntryLabels(entry)
    }

    public get ActionLabel(): string
    {
        return this.labels.ActionLabel
    }

    public get Actor(): string
    {
        return this.labels.Entry.actor
    }

    public get WhenLabel(): string
    {
        return this.labels.WhenLabel
    }

    public get Method(): string
    {
        return this.labels.Entry.method
    }

    public get Path(): string
    {
        return this.labels.Entry.path
    }

    public get StatusText(): string
    {
        return String(this.labels.Entry.status)
    }

    public get OutcomeLabel(): string
    {
        return this.labels.OutcomeLabel
    }

    // What the operation kept or skipped (e.g. a hive delete's retained objects); '' when it says nothing.
    public get Note(): string
    {
        return this.labels.Entry.note ?? ActivityEntryPageViewModel.NoNote
    }

    public get HasNote(): boolean
    {
        return this.Note.length > 0
    }

    public get BackCommand(): RelayCommand
    {
        return this.section.BackCommand
    }

    protected override async LoadCore(): Promise<boolean>
    {
        return true
    }
}
