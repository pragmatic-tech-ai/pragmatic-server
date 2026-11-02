import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable, type IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { ActivityLog, type ActivityEntry } from '../../activity-log.js'
import { ShownPage, type IShownPage } from '../../shell/shown-page.js'
import { TenantPageViewModel } from '../../shell/tenant-page-view-model.js'
import type { TenantSessionService } from '../../shell/tenant-session-service.js'

// One observed tenant event: what happened and how long ago.
export class ActivityRowViewModel extends Observable
{
    public constructor(private readonly entry: ActivityEntry, private readonly now: () => number)
    {
        super()
    }

    public get Summary(): string
    {
        return this.entry.Summary
    }

    public get EnvironmentName(): string
    {
        return this.entry.EnvironmentName
    }

    public get WhenLabel(): string
    {
        return this.entry.RelativeTime(this.now)
    }
}

// Builds activity rows from the session's log; shared by the Activity page,
// the Overview's Recent activity and an environment's own activity.
export class ActivityRows
{
    public static From(entries: readonly ActivityEntry[], now: () => number = () => Date.now()): ObservableCollection<ActivityRowViewModel>
    {
        const rows = new ObservableCollection<ActivityRowViewModel>()
        for (const entry of entries)
        {
            rows.Add(new ActivityRowViewModel(entry, now))
        }
        return rows
    }
}

// Activity: the tenant events this session has observed, newest first. The
// log lives only in this browser tab (it is not persisted), so a fresh
// session starts empty. New events show as they arrive.
export class ActivityPageViewModel extends TenantPageViewModel implements IShownPage
{
    private static readonly RowsProperty = 'Rows'

    private rows = new ObservableCollection<ActivityRowViewModel>()
    private readonly backCommand: RelayCommand
    private subscription: IDisposable | undefined

    public constructor(session: TenantSessionService, back: RelayCommand)
    {
        super(session)
        this.backCommand = back
        ShownPage.Register(this)
    }

    // Follows the session's activity only while shown (and reloads when it
    // shows again), like every other page holding a live subscription.
    public OnShown(): void
    {
        if (this.subscription === undefined)
        {
            this.subscription = this.Session.Activity.PropertyChanged(ActivityLog.EntriesProperty)
                .subscribe(() => { void this.Refresh() })
        }
    }

    public OnHidden(): void
    {
        this.subscription?.dispose()
        this.subscription = undefined
    }

    public get Rows(): ObservableCollection<ActivityRowViewModel>
    {
        return this.rows
    }

    public get BackCommand(): RelayCommand
    {
        return this.backCommand
    }

    protected override async LoadCore(): Promise<boolean>
    {
        const old = this.rows
        this.rows = ActivityRows.From(this.Session.Activity.Entries)
        this.RaisePropertyChanged(ActivityPageViewModel.RowsProperty, old, this.rows)
        return this.rows.Count > 0
    }
}
