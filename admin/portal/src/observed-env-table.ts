import { DataTable, PillKind, PillKinds, PillTone, TableDensity } from './kit/index.js'
import type { TableColumn } from './kit/index.js'

export interface ObservedEnvRow
{
    name: string
    ready: boolean
    image: string
    detail: string
}

// Shared read-only table of environments observed from a hive's last check-in.
export class ObservedEnvTable
{
    private static readonly EmptyText = 'No environments observed.'
    private static readonly EnvKey = 'environment'
    private static readonly StatusKey = 'status'
    private static readonly ImageKey = 'image'
    private static readonly DetailKey = 'detail'
    private static readonly EnvHeader = 'Environment'
    private static readonly StatusHeader = 'Status'
    private static readonly ImageHeader = 'Image'
    private static readonly DetailHeader = 'Detail'

    public static Build(rows: readonly ObservedEnvRow[]): DataTable<ObservedEnvRow>
    {
        return new DataTable<ObservedEnvRow>({
            columns: ObservedEnvTable.Columns(),
            rows,
            density: TableDensity.Dense,
            searchText: r => r.name,
            emptyText: ObservedEnvTable.EmptyText,
        })
    }

    private static Columns(): TableColumn<ObservedEnvRow>[]
    {
        return [
            {
                key: ObservedEnvTable.EnvKey,
                header: ObservedEnvTable.EnvHeader,
                cell: r => r.name,
                sort: (a, b) => a.name.localeCompare(b.name),
            },
            {
                key: ObservedEnvTable.StatusKey,
                header: ObservedEnvTable.StatusHeader,
                cell: r => PillKinds.For(r.ready ? PillKind.Healthy : PillKind.Failing).label,
                tone: r => r.ready ? undefined : PillTone.Danger,
            },
            { key: ObservedEnvTable.ImageKey, header: ObservedEnvTable.ImageHeader, cell: r => r.image },
            { key: ObservedEnvTable.DetailKey, header: ObservedEnvTable.DetailHeader, cell: r => r.detail },
        ]
    }
}
