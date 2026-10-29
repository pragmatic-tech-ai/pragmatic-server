import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import type { ControlPlaneClient } from './api-client.js'
import { ActivityViewModel } from './activity-view-model.js'
import type { ActivityRow } from './activity-view-model.js'
import type { TableColumn } from './kit/index.js'
import { SectionContainerView } from './section-container-view.js'
import type { SectionLabels } from './section-container-view.js'

// Activity section: a read-only list of the operator-action audit log (open to every operator).
export class ActivityView extends SectionContainerView<ActivityRow>
{
    private static readonly ListBreadcrumb: readonly string[] = ['Activity']
    private static readonly ListTitle = 'Activity'
    private static readonly EmptyTitle = 'No operator activity recorded yet.'
    private static readonly ErrorTitle = 'Could not load the activity log.'
    private static readonly TableEmptyText = 'No activity matches.'
    private static readonly SearchSeparator = ' '
    private static readonly WhenKey = 'when'
    private static readonly WhoKey = 'who'
    private static readonly ActionKey = 'action'
    private static readonly OutcomeKey = 'outcome'
    private static readonly WhenHeader = 'When'
    private static readonly WhoHeader = 'Who'
    private static readonly ActionHeader = 'Action'
    private static readonly OutcomeHeader = 'Outcome'

    private model: ActivityViewModel | undefined = undefined

    public constructor(private readonly client: ControlPlaneClient)
    {
        super()
    }

    protected Labels(): SectionLabels
    {
        return {
            listBreadcrumb: ActivityView.ListBreadcrumb,
            listTitle: ActivityView.ListTitle,
            emptyTitle: ActivityView.EmptyTitle,
            errorTitle: ActivityView.ErrorTitle,
            tableEmptyText: ActivityView.TableEmptyText,
        }
    }

    protected SearchText(row: ActivityRow): string
    {
        return row.actor + ActivityView.SearchSeparator + row.actionLabel
    }

    protected async LoadRows(): Promise<readonly ActivityRow[]>
    {
        const activity = await this.client.ListActivity()
        if (this.model === undefined)
        {
            this.model = new ActivityViewModel(activity)
        }
        else
        {
            this.model.Update(activity)
        }
        return this.model.Rows
    }

    protected BuildDetail(_row: ActivityRow): Promise<Visual | undefined>
    {
        return Promise.resolve(undefined)
    }

    protected Columns(): TableColumn<ActivityRow>[]
    {
        return [
            { key: ActivityView.WhenKey, header: ActivityView.WhenHeader, cell: r => r.whenLabel },
            { key: ActivityView.WhoKey, header: ActivityView.WhoHeader, cell: r => r.actor },
            { key: ActivityView.ActionKey, header: ActivityView.ActionHeader, cell: r => r.actionLabel },
            { key: ActivityView.OutcomeKey, header: ActivityView.OutcomeHeader, cell: r => String(r.status), tone: r => r.tone },
        ]
    }
}
