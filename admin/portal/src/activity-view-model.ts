import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { PillTone } from './kit/index.js'
import { PortalDates } from './portal-dates.js'
import type { ActivityDto } from './portal-types.js'

export interface ActivityRow
{
    whenLabel: string
    actor: string
    actionLabel: string
    status: number
    tone: PillTone
}

interface ActionRule
{
    method: string
    test: RegExp
    label: string
}

// Operator-action audit log: derives friendly action labels and outcome tones from raw method/path/status.
export class ActivityViewModel extends Observable
{
    public static readonly RowsProperty = 'Rows'

    private static readonly SuccessMin = 200
    private static readonly SuccessMax = 299
    private static readonly ServerErrorMin = 500
    private static readonly FallbackSeparator = ' '
    private static readonly QueryMark = '?'

    // Applied in order; the first matching (method, path) wins. Id segments match any non-slash run.
    private static readonly Actions: readonly ActionRule[] = [
        { method: 'POST', test: /^\/api\/manifests\/?$/, label: 'Published a version' },
        { method: 'POST', test: /^\/api\/manifests\/[^/]+\/withdrawn\/?$/, label: 'Withdrew a version' },
        { method: 'DELETE', test: /^\/api\/manifests\/[^/]+\/withdrawn\/?$/, label: 'Restored a version' },
        { method: 'POST', test: /^\/api\/tenants\/[^/]+\/gating\/?$/, label: 'Gated a version' },
        { method: 'DELETE', test: /^\/api\/tenants\/[^/]+\/gating\/[^/]+\/?$/, label: 'Ungated a version' },
        { method: 'PUT', test: /^\/api\/tenants\/[^/]+\/policy\/channels\/?$/, label: 'Set subscribed channels' },
        { method: 'PUT', test: /^\/api\/tenants\/[^/]+\/policy\/min-version\/?$/, label: 'Set the version floor' },
        { method: 'DELETE', test: /^\/api\/tenants\/[^/]+\/policy\/min-version\/?$/, label: 'Cleared the version floor' },
        { method: 'POST', test: /^\/api\/tenants\/[^/]+\/policy\/hold\/?$/, label: 'Held a tenant' },
        { method: 'DELETE', test: /^\/api\/tenants\/[^/]+\/policy\/hold\/?$/, label: 'Released a tenant' },
        { method: 'POST', test: /^\/api\/operators\/?$/, label: 'Invited an operator' },
        { method: 'POST', test: /^\/api\/operators\/role\/?$/, label: 'Changed an operator role' },
        { method: 'POST', test: /^\/api\/operators\/password-reset\/?$/, label: 'Reset a password' },
        { method: 'POST', test: /^\/api\/operators\/disabled\/?$/, label: 'Enabled or disabled an operator' },
        { method: 'POST', test: /^\/api\/operators\/revoke-sessions\/?$/, label: 'Revoked sessions' },
        { method: 'POST', test: /^\/api\/provision\/?$/, label: 'Provisioned' },
        { method: 'POST', test: /^\/api\/clients\/?$/, label: 'Created a client' },
        { method: 'DELETE', test: /^\/api\/clients\/[^/]+\/?$/, label: 'Deleted a client' },
        { method: 'POST', test: /^\/api\/tenants\/?$/, label: 'Created a tenant' },
        { method: 'DELETE', test: /^\/api\/tenants\/[^/]+\/?$/, label: 'Deleted a tenant' },
        { method: 'POST', test: /^\/api\/hives\/?$/, label: 'Created a hive' },
        { method: 'DELETE', test: /^\/api\/hives\/[^/]+\/?$/, label: 'Deleted a hive' },
    ]

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
            actionLabel: ActivityViewModel.ActionLabel(a.method, a.path),
            status: a.status,
            tone: ActivityViewModel.ToneFor(a.status),
        }))
    }

    private static ActionLabel(method: string, path: string): string
    {
        const bare = path.split(ActivityViewModel.QueryMark)[0]
        for (const rule of ActivityViewModel.Actions)
        {
            if (rule.method === method && rule.test.test(bare))
            {
                return rule.label
            }
        }
        return method + ActivityViewModel.FallbackSeparator + bare
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
