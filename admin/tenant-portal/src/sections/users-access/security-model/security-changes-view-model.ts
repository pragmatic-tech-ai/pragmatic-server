import { ObservableCollection } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { SecurityChangesDto } from '../../../tenant-types.js'
import type { TenantSessionService } from '../../../shell/tenant-session-service.js'
import { FieldAccess } from './security-overrides.js'
import { SecurityModelText } from './security-model-text.js'

// The environment the change log is read for.
export interface ISecurityChangesHost
{
    readonly Environment: string | undefined
}

// One line of a change-log entry; a row the entry's list binds to.
export class SecurityChangeLineViewModel extends Observable
{
    public constructor(public readonly Text: string)
    {
        super()
    }
}

// One deploy's security changes: a heading (delivery, version, UTC time) and
// one plain-language line per change.
export class SecurityChangeEntryViewModel extends Observable
{
    public readonly HeadingText: string
    public readonly Lines: readonly string[]
    public readonly LineRows: ObservableCollection<SecurityChangeLineViewModel>

    public constructor(public readonly Change: SecurityChangesDto)
    {
        super()
        this.HeadingText = SecurityModelText.ChangeHeading(Change.delivery, Change.version, Change.at)
        this.Lines = SecurityChangeEntryViewModel.LinesOf(Change)
        this.LineRows = new ObservableCollection<SecurityChangeLineViewModel>()
        for (const line of this.Lines)
        {
            this.LineRows.Add(new SecurityChangeLineViewModel(line))
        }
    }

    private static LinesOf(c: SecurityChangesDto): string[]
    {
        const T = SecurityModelText
        return [
            ...c.roleDefaults.map(r => T.RoleDefaultChange(r.role, r.concept, r.action, r.before, r.after)),
            ...c.profileDefaults.map(p => T.ProfileDefaultChange(p.profile, p.concept, p.field,
                p.before === null ? null : FieldAccess.From(p.before), p.after === null ? null : FieldAccess.From(p.after))),
            ...c.securedFieldsAdded.map(f => T.SecuredFieldAdded(f.concept, f.field)),
            ...c.securedFieldsRemoved.map(f => T.SecuredFieldRemoved(f.concept, f.field)),
            ...c.roleOverridesDropped.map(o => T.RoleOverrideDropped(o.role, o.concept, o.action)),
            ...c.profileOverridesDropped.map(o => T.ProfileOverrideDropped(o.profile, o.concept, o.field)),
            ...c.rolesRemoved.map(r => T.RoleRemoved(r.role)),
            ...c.profilesRemoved.map(p => T.ProfileRemoved(p.profile)),
        ]
    }
}

// The environment's security change log, newest deploy first. A failed load
// is shown as ErrorText, never swallowed.
export class SecurityChangesViewModel extends Observable
{
    private static readonly EntriesProperty = 'Entries'
    private static readonly HasNoEntriesProperty = 'HasNoEntries'
    private static readonly ErrorTextProperty = 'ErrorText'
    private static readonly HasErrorProperty = 'HasError'
    private static readonly Empty = ''

    private entries = new ObservableCollection<SecurityChangeEntryViewModel>()
    private errorText = SecurityChangesViewModel.Empty
    private generation = 0

    public constructor(private readonly session: TenantSessionService, private readonly host: ISecurityChangesHost)
    {
        super()
    }

    public get Entries(): ObservableCollection<SecurityChangeEntryViewModel>
    {
        return this.entries
    }

    public get HasNoEntries(): boolean
    {
        return this.entries.Count === 0 && this.errorText.length === 0
    }

    public get NoEntriesText(): string
    {
        return SecurityModelText.NoChangesText
    }

    public get ErrorText(): string
    {
        return this.errorText
    }

    public get HasError(): boolean
    {
        return this.errorText.length > 0
    }

    // Reloads the log for the host's environment; the last refresh wins.
    public async Refresh(): Promise<void>
    {
        const environment = this.host.Environment
        const generation = ++this.generation
        let loaded: SecurityChangesDto[] = []
        let failure = SecurityChangesViewModel.Empty
        if (environment !== undefined)
        {
            try
            {
                loaded = await this.session.Client.ListSecurityChanges(environment)
            }
            catch (e)
            {
                failure = e instanceof Error ? e.message : String(e)
            }
        }
        if (generation === this.generation)
        {
            this.Show(loaded, failure)
        }
    }

    // Forgets the shown log and abandons any refresh in flight (the environment changed).
    public Invalidate(): void
    {
        this.generation++
        this.Show([], SecurityChangesViewModel.Empty)
    }

    private Show(changes: readonly SecurityChangesDto[], failure: string): void
    {
        const P = SecurityChangesViewModel
        const before = [this.entries, this.HasNoEntries, this.errorText, this.HasError] as const
        this.entries = new ObservableCollection<SecurityChangeEntryViewModel>()
        for (const change of P.NewestFirst(changes))
        {
            this.entries.Add(new SecurityChangeEntryViewModel(change))
        }
        this.errorText = failure
        this.RaisePropertyChanged(P.EntriesProperty, before[0], this.entries)
        this.RaisePropertyChanged(P.HasNoEntriesProperty, before[1], this.HasNoEntries)
        this.RaisePropertyChanged(P.ErrorTextProperty, before[2], this.errorText)
        this.RaisePropertyChanged(P.HasErrorProperty, before[3], this.HasError)
    }

    // Sorted by time, newest first; the server order is not trusted.
    private static NewestFirst(changes: readonly SecurityChangesDto[]): SecurityChangesDto[]
    {
        return [...changes].sort((a, b) => SecurityChangesViewModel.TimeOf(b) - SecurityChangesViewModel.TimeOf(a))
    }

    private static TimeOf(change: SecurityChangesDto): number
    {
        const ms = Date.parse(change.at)
        return Number.isNaN(ms) ? 0 : ms
    }
}
