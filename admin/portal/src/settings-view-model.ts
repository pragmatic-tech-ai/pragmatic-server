import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { OperatorContext } from './operator-context.js'
import type { OperatorSummaryDto } from './portal-types.js'

export interface OperatorRow
{
    email: string
    roleLabel: string
}

// Settings screen: the signed-in operator's session plus the (role-gated) operator roster.
export class SettingsViewModel extends Observable
{
    public static readonly RowsProperty = 'Rows'

    private readonly email: string
    private readonly roleLabel: string
    private rows: readonly OperatorRow[] = []

    public constructor(session: { email: string; roleLabel: string })
    {
        super()
        this.email = session.email
        this.roleLabel = session.roleLabel
    }

    public get Email(): string
    {
        return this.email
    }

    public get RoleLabel(): string
    {
        return this.roleLabel
    }

    public get Rows(): readonly OperatorRow[]
    {
        return this.rows
    }

    public Update(summaries: readonly OperatorSummaryDto[]): void
    {
        const old = this.rows
        this.rows = SettingsViewModel.Derive(summaries)
        this.RaisePropertyChanged(SettingsViewModel.RowsProperty, old, this.rows)
    }

    private static Derive(summaries: readonly OperatorSummaryDto[]): OperatorRow[]
    {
        const rows: OperatorRow[] = summaries.map(s => ({ email: s.email, roleLabel: OperatorContext.RoleLabel(s.role) }))
        // Array.prototype.sort is stable.
        return rows.sort((a, b) => a.email.localeCompare(b.email))
    }
}
