import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { EnvironmentDto, GraphDto, PromotionResultDto } from './portal-types.js'

// The slice of ControlPlaneClient the view-model needs (a seam so tests need no live server).
export interface IPromoteGraphSource
{
    ListGraphs(envName: string): Promise<GraphDto[]>
    ListEnvironments(): Promise<EnvironmentDto[]>
    PromoteGraph(sourceEnv: string, graphName: string, targetEnv: string): Promise<PromotionResultDto>
}

// Promote flow: the dev env's graphs, the runtime-only targets, the current selection.
export class PromoteGraphViewModel extends Observable
{
    public static readonly GraphsProperty = 'Graphs'
    public static readonly TargetsProperty = 'Targets'
    public static readonly SelectedGraphProperty = 'SelectedGraph'
    public static readonly SelectedTargetEnvProperty = 'SelectedTargetEnv'
    public static readonly NothingSelectedStatus = 'select a graph and a target runtime environment'
    private static readonly RuntimeType = 'runtime'

    private graphs: readonly GraphDto[] = []
    private targets: readonly EnvironmentDto[] = []
    private selectedGraph = ''
    private selectedTargetEnv = ''

    public constructor(private readonly source: IPromoteGraphSource, private readonly devEnvName: string)
    {
        super()
    }

    public get Graphs(): readonly GraphDto[]
    {
        return this.graphs
    }

    public get Targets(): readonly EnvironmentDto[]
    {
        return this.targets
    }

    public get SelectedGraph(): string
    {
        return this.selectedGraph
    }

    public set SelectedGraph(value: string)
    {
        const old = this.selectedGraph
        this.selectedGraph = value
        this.RaisePropertyChanged(PromoteGraphViewModel.SelectedGraphProperty, old, value)
    }

    public get SelectedTargetEnv(): string
    {
        return this.selectedTargetEnv
    }

    public set SelectedTargetEnv(value: string)
    {
        const old = this.selectedTargetEnv
        this.selectedTargetEnv = value
        this.RaisePropertyChanged(PromoteGraphViewModel.SelectedTargetEnvProperty, old, value)
    }

    public get CanPromote(): boolean
    {
        return this.selectedGraph !== '' && this.selectedTargetEnv !== ''
    }

    // Loads the dev env's graphs and the runtime-type environments.
    public async Load(): Promise<void>
    {
        const oldGraphs = this.graphs
        const oldTargets = this.targets
        this.graphs = await this.source.ListGraphs(this.devEnvName)
        this.targets = (await this.source.ListEnvironments()).filter(e => e.type === PromoteGraphViewModel.RuntimeType)
        this.RaisePropertyChanged(PromoteGraphViewModel.GraphsProperty, oldGraphs, this.graphs)
        this.RaisePropertyChanged(PromoteGraphViewModel.TargetsProperty, oldTargets, this.targets)
    }

    public async Promote(): Promise<PromotionResultDto>
    {
        if (!this.CanPromote)
        {
            throw new Error(PromoteGraphViewModel.NothingSelectedStatus)
        }
        return await this.source.PromoteGraph(this.devEnvName, this.selectedGraph, this.selectedTargetEnv)
    }
}
