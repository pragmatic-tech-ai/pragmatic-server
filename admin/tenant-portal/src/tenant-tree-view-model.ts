import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { TenantEventType } from './tenant-types.js'
import type { EnvironmentDto, HiveDto, TenantEvent } from './tenant-types.js'

// The slice of TenantApiClient the tree needs.
export interface ITreeSource
{
    ListHives(): Promise<HiveDto[]>
    ListEnvironments(): Promise<EnvironmentDto[]>
}

export type HiveNode = { hive: HiveDto; environments: EnvironmentDto[] }

export enum SelectionKind
{
    Hive,
    Environment,
}

export type TreeSelection =
    | { kind: SelectionKind.Hive; hive: HiveDto }
    | { kind: SelectionKind.Environment; env: EnvironmentDto }

// Hive -> environment tree state; re-pulls on environment-changed events.
export class TenantTreeViewModel extends Observable
{
    public static readonly NodesProperty = 'Nodes'
    public static readonly SelectedProperty = 'Selected'

    private nodes: readonly HiveNode[] = []
    private selected: TreeSelection | undefined
    private pending: Promise<void> = Promise.resolve()

    public constructor(private readonly source: ITreeSource)
    {
        super()
    }

    public get Nodes(): readonly HiveNode[]
    {
        return this.nodes
    }

    public get Selected(): TreeSelection | undefined
    {
        return this.selected
    }

    public Select(sel: TreeSelection): void
    {
        const old = this.selected
        this.selected = sel
        this.RaisePropertyChanged(TenantTreeViewModel.SelectedProperty, old, sel)
    }

    public async Load(): Promise<void>
    {
        const [hives, envs] = await Promise.all([this.source.ListHives(), this.source.ListEnvironments()])
        const old = this.nodes
        this.nodes = hives.map(hive => ({ hive, environments: envs.filter(e => e.hiveId === hive.id) }))
        this.RaisePropertyChanged(TenantTreeViewModel.NodesProperty, old, this.nodes)
    }

    // Re-pulls the tree when a known environment changed. Failures are swallowed
    // (the next event or Refresh retries); Settled() awaits the in-flight pull.
    public ApplyEvent(ev: TenantEvent): void
    {
        if (ev.type !== TenantEventType.EnvironmentChanged)
        {
            return
        }
        if (!this.nodes.some(n => n.environments.some(e => e.name === ev.environmentName)))
        {
            return
        }
        this.pending = this.Load().catch(() => undefined)
    }

    public Settled(): Promise<void>
    {
        return this.pending
    }
}
