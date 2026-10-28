import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { FleetHiveDto } from './portal-types.js'

export enum FleetConnection
{
    Connected,
    Quiet,
    Awaiting,
}

export enum FleetIssueKind
{
    Quiet,
    Awaiting,
    EnvironmentNotReady,
}

export enum FleetSegment
{
    All,
    NeedsAttention,
    NotCheckingIn,
}

export interface FleetIssue
{
    kind: FleetIssueKind
    summary: string
}

export interface FleetRow
{
    id: string
    displayName: string
    ownerLabel: string
    connection: FleetConnection
    lastSeenLabel: string
    envCount: number
    notReadyCount: number
    issues: FleetIssue[]
}

// Client-side derivation of fleet state from DTO facts only (lastSeen, ready).
export class FleetViewModel extends Observable
{
    public static readonly SegmentProperty = 'Segment'
    public static readonly RowsProperty = 'Rows'

    private static readonly QuietThresholdMs = 6 * 60 * 60 * 1000
    private static readonly MinuteMs = 60 * 1000
    private static readonly HourMs = 60 * 60 * 1000
    private static readonly DayMs = 24 * 60 * 60 * 1000
    private static readonly NeverLabel = 'Never dialled in'
    private static readonly UnassignedLabel = '(unassigned)'
    private static readonly OwnerSeparator = ' / '
    private static readonly JustNowLabel = 'Last check-in just now'
    private static readonly AgoTemplate = 'Last check-in {n} {unit} ago'
    private static readonly CountToken = '{n}'
    private static readonly UnitToken = '{unit}'
    private static readonly MinuteUnit = 'min'
    private static readonly HourUnit = 'hr'
    private static readonly DayUnit = 'day'
    private static readonly PluralSuffix = 's'
    private static readonly QuietSummary = 'Has not checked in recently'
    private static readonly AwaitingSummary = 'Awaiting first check-in'
    private static readonly NotReadyOneSummary = '1 environment not ready'
    private static readonly NotReadyManySummary = '{n} environments not ready'

    private rows: readonly FleetRow[] = []
    private segment: FleetSegment = FleetSegment.All

    public constructor(
        rows: FleetHiveDto[],
        private readonly now: () => Date = () => new Date(),
        private readonly quietThresholdMs: number = FleetViewModel.QuietThresholdMs,
    )
    {
        super()
        this.rows = this.Derive(rows)
    }

    public get Rows(): readonly FleetRow[]
    {
        return this.rows
    }

    public get NeedsAttention(): readonly FleetRow[]
    {
        return this.rows
            .filter(r => r.issues.length > 0)
            .map((r, i) => ({ r, i, s: FleetViewModel.Severity(r) }))
            .sort((a, b) => b.s - a.s || a.i - b.i)
            .map(x => x.r)
    }

    public get HiveCount(): number
    {
        return this.rows.length
    }

    public get NeedAttentionCount(): number
    {
        return this.rows.filter(r => r.issues.length > 0).length
    }

    public get NotCheckingInCount(): number
    {
        return this.rows.filter(r => FleetViewModel.IsNotCheckingIn(r)).length
    }

    public get EnvironmentsObserved(): number
    {
        return this.rows.reduce((sum, r) => sum + r.envCount, 0)
    }

    public get Segment(): FleetSegment
    {
        return this.segment
    }

    public SetSegment(s: FleetSegment): void
    {
        const old = this.segment
        if (old === s)
        {
            return
        }
        this.segment = s
        this.RaisePropertyChanged(FleetViewModel.SegmentProperty, old, s)
    }

    public Visible(): readonly FleetRow[]
    {
        switch (this.segment)
        {
            case FleetSegment.NeedsAttention:
                return this.rows.filter(r => r.issues.length > 0)
            case FleetSegment.NotCheckingIn:
                return this.rows.filter(r => FleetViewModel.IsNotCheckingIn(r))
            default:
                return this.rows
        }
    }

    public Update(rows: FleetHiveDto[]): void
    {
        const old = this.rows
        this.rows = this.Derive(rows)
        this.RaisePropertyChanged(FleetViewModel.RowsProperty, old, this.rows)
    }

    private static IsNotCheckingIn(r: FleetRow): boolean
    {
        return r.connection !== FleetConnection.Connected
    }

    // danger (2) > warning (1) > info (0)
    private static Severity(r: FleetRow): number
    {
        let max = 0
        for (const i of r.issues)
        {
            const s = i.kind === FleetIssueKind.EnvironmentNotReady ? 2 : i.kind === FleetIssueKind.Quiet ? 1 : 0
            max = Math.max(max, s)
        }
        return max
    }

    private Derive(dtos: FleetHiveDto[]): FleetRow[]
    {
        return dtos.map(d => this.DeriveRow(d))
    }

    private DeriveRow(d: FleetHiveDto): FleetRow
    {
        const issues: FleetIssue[] = []
        let connection: FleetConnection
        let label: string
        if (d.lastSeen === null)
        {
            connection = FleetConnection.Awaiting
            label = FleetViewModel.NeverLabel
            issues.push({ kind: FleetIssueKind.Awaiting, summary: FleetViewModel.AwaitingSummary })
        }
        else
        {
            const age = this.now().getTime() - new Date(d.lastSeen).getTime()
            label = FleetViewModel.RelativeLabel(age)
            if (age < this.quietThresholdMs)
            {
                connection = FleetConnection.Connected
            }
            else
            {
                connection = FleetConnection.Quiet
                issues.push({ kind: FleetIssueKind.Quiet, summary: FleetViewModel.QuietSummary })
            }
        }
        const notReady = d.environments.filter(e => e.ready === false).length
        if (notReady > 0)
        {
            const summary = notReady === 1
                ? FleetViewModel.NotReadyOneSummary
                : FleetViewModel.NotReadyManySummary.replace(FleetViewModel.CountToken, String(notReady))
            issues.push({ kind: FleetIssueKind.EnvironmentNotReady, summary })
        }
        return {
            id: d.id,
            displayName: d.displayName,
            ownerLabel: FleetViewModel.OwnerLabel(d),
            connection,
            lastSeenLabel: label,
            envCount: d.environments.length,
            notReadyCount: notReady,
            issues,
        }
    }

    private static OwnerLabel(d: FleetHiveDto): string
    {
        const parts = [d.client?.displayName, d.tenant?.displayName].filter((p): p is string => !!p)
        return parts.length > 0 ? parts.join(FleetViewModel.OwnerSeparator) : FleetViewModel.UnassignedLabel
    }

    private static RelativeLabel(ageMs: number): string
    {
        if (ageMs < FleetViewModel.MinuteMs)
        {
            return FleetViewModel.JustNowLabel
        }
        let n: number
        let unit: string
        if (ageMs < FleetViewModel.HourMs)
        {
            n = Math.floor(ageMs / FleetViewModel.MinuteMs)
            unit = FleetViewModel.MinuteUnit
        }
        else if (ageMs < FleetViewModel.DayMs)
        {
            n = Math.floor(ageMs / FleetViewModel.HourMs)
            unit = FleetViewModel.HourUnit
        }
        else
        {
            n = Math.floor(ageMs / FleetViewModel.DayMs)
            unit = FleetViewModel.DayUnit + (n === 1 ? '' : FleetViewModel.PluralSuffix)
        }
        return FleetViewModel.AgoTemplate
            .replace(FleetViewModel.CountToken, String(n))
            .replace(FleetViewModel.UnitToken, unit)
    }
}
