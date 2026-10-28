import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { PillKind } from './kit/index.js'
import { TenantEventType } from './tenant-types.js'
import type { TenantEvent } from './tenant-types.js'

// One observed tenant event, stamped with CLIENT time. Plain class (not Observable); structurally
// satisfies the kit ActivityListItem contract (Summary / Pill / RelativeTime).
export class ActivityEntry
{
    private static readonly NamePlaceholder = '{name}'
    private static readonly Templates: ReadonlyMap<TenantEventType, string> = new Map<TenantEventType, string>([
        [TenantEventType.EnvironmentCreated, 'Environment {name} was created'],
        [TenantEventType.EnvironmentChanged, 'Environment {name} was updated'],
        [TenantEventType.EnvironmentDeleted, 'Environment {name} was deleted'],
        [TenantEventType.HealthChanged, 'Health changed for {name}'],
    ])
    private static readonly JustNow = 'just now'
    private static readonly MinutesSuffix = 'm ago'
    private static readonly HoursSuffix = 'h ago'
    private static readonly MillisPerMinute = 60_000
    private static readonly MillisPerHour = 3_600_000

    public constructor(
        private readonly type: TenantEventType,
        private readonly environmentName: string,
        private readonly observedAt: number)
    {
    }

    public get Type(): TenantEventType
    {
        return this.type
    }

    public get EnvironmentName(): string
    {
        return this.environmentName
    }

    public get ObservedAt(): number
    {
        return this.observedAt
    }

    public get Summary(): string
    {
        const template = ActivityEntry.Templates.get(this.type) ?? ActivityEntry.NamePlaceholder
        return template.replace(ActivityEntry.NamePlaceholder, this.environmentName)
    }

    public get Pill(): PillKind
    {
        return PillKind.Observed
    }

    public RelativeTime(now?: () => number): string
    {
        const elapsed = (now?.() ?? Date.now()) - this.observedAt
        if (elapsed < ActivityEntry.MillisPerMinute)
        {
            return ActivityEntry.JustNow
        }
        if (elapsed < ActivityEntry.MillisPerHour)
        {
            return Math.floor(elapsed / ActivityEntry.MillisPerMinute) + ActivityEntry.MinutesSuffix
        }
        return Math.floor(elapsed / ActivityEntry.MillisPerHour) + ActivityEntry.HoursSuffix
    }
}

// Session-scoped, in-memory log of tenant events, newest-first and capped. Not persisted.
export class ActivityLog extends Observable
{
    public static readonly EntriesProperty = 'Entries'

    private entries: readonly ActivityEntry[] = []

    public constructor(
        private readonly cap = 200,
        private readonly now: () => number = () => Date.now())
    {
        super()
    }

    public get Entries(): readonly ActivityEntry[]
    {
        return this.entries
    }

    public get Count(): number
    {
        return this.entries.length
    }

    public EntriesFor(environmentName: string): readonly ActivityEntry[]
    {
        return this.entries.filter(e => e.EnvironmentName === environmentName)
    }

    public Record(ev: TenantEvent): void
    {
        const old = this.entries
        const entry = new ActivityEntry(ev.type, ev.environmentName, this.now())
        this.entries = [entry, ...old].slice(0, this.cap)
        this.RaisePropertyChanged(ActivityLog.EntriesProperty, old, this.entries)
    }
}
