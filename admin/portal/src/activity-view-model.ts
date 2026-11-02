import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { PillTone } from './kit/index.js'
import { PortalDates } from './portal-dates.js'
import type { ActivityDto } from './portal-types.js'
import { ActivityActions } from './sections/activity/activity-actions.js'

export interface ActivityRow
{
    whenLabel: string
    actor: string
    actionLabel: string
    status: number
    tone: PillTone
}

// Operator-action audit log: derives friendly action labels and outcome tones from raw method/path/status.
export class ActivityViewModel extends Observable
{
    public static readonly RowsProperty = 'Rows'

    private static readonly SuccessMin = 200
    private static readonly SuccessMax = 299
    private static readonly ServerErrorMin = 500

    private rows: readonly ActivityRow[] = []

    public constructor(activity: readonly ActivityDto[])
    {
        super()
        this.rows = ActivityViewModel.Derive(activity)
    }

    public get Rows(): readonly ActivityRow[]
    {
        return this.rows
    }

    public Update(activity: readonly ActivityDto[]): void
    {
        const old = this.rows
        this.rows = ActivityViewModel.Derive(activity)
        this.RaisePropertyChanged(ActivityViewModel.RowsProperty, old, this.rows)
    }

    private static Derive(activity: readonly ActivityDto[]): ActivityRow[]
    {
        return activity.map(a => ({
            whenLabel: PortalDates.Label(a.at),
            actor: a.actor,
            actionLabel: ActivityActions.Label(a.method, a.path),
            status: a.status,
            tone: ActivityViewModel.ToneFor(a.status),
        }))
    }

    private static ToneFor(status: number): PillTone
    {
        if (status >= ActivityViewModel.SuccessMin && status <= ActivityViewModel.SuccessMax)
        {
            return PillTone.Success
        }
        return status >= ActivityViewModel.ServerErrorMin ? PillTone.Danger : PillTone.Warning
    }
}
