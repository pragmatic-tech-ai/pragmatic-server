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
    private generation = 0

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
        const generation = ++this.generation
        const [hives, envs] = await Promise.all([this.source.ListHives(), this.source.ListEnvironments()])
        if (generation !== this.generation)
        {
            return
        }
        const byHive = new Map<string, HiveNode>()
        for (const hive of hives)
        {
            byHive.set(hive.id, { hive, environments: [] })
        }
        for (const env of envs)
        {
            if (env.hiveId !== undefined)
            {
                byHive.get(env.hiveId)?.environments.push(env)
            }
        }
        const old = this.nodes
        this.nodes = hives.map(h => byHive.get(h.id)!)
        this.RaisePropertyChanged(TenantTreeViewModel.NodesProperty, old, this.nodes)
    }

    // Re-pulls the tree on a lifecycle event: a create always reloads (the new
    // environment is not yet in the tree), while a change or delete reloads only
    // when the environment is one we already show. Resolves true when it reloaded,
    // false when the event was ignored. Load failures are swallowed (the next event
    // or Refresh retries) and still resolve true.
    public async ApplyEvent(ev: TenantEvent): Promise<boolean>
    {
        if (ev.type === TenantEventType.EnvironmentCreated)
        {
            await this.Load().catch(() => undefined)
            return true
        }
        if (ev.type !== TenantEventType.EnvironmentChanged && ev.type !== TenantEventType.EnvironmentDeleted)
        {
            return false
        }
        if (!this.nodes.some(n => n.environments.some(e => e.name === ev.environmentName)))
        {
            return false
        }
        await this.Load().catch(() => undefined)
        return true
    }
}
