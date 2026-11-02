import { ObservableCollection } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { FleetEnvDto } from '../portal-types.js'

// One environment as the hive last reported it.
export class ObservedEnvironmentRowViewModel extends Observable
{
    private static readonly ReadyLabel = 'Ready'
    private static readonly NotReadyLabel = 'Not ready'
    private static readonly NoImageLabel = '-'

    public constructor(private readonly env: FleetEnvDto)
    {
        super()
    }

    public get Name(): string
    {
        return this.env.name
    }

    public get IsReady(): boolean
    {
        return this.env.ready
    }

    public get StatusLabel(): string
    {
        return this.env.ready ? ObservedEnvironmentRowViewModel.ReadyLabel : ObservedEnvironmentRowViewModel.NotReadyLabel
    }

    public get Image(): string
    {
        return this.env.image ?? ObservedEnvironmentRowViewModel.NoImageLabel
    }

    public get Detail(): string
    {
        return this.env.detail
    }
}

// The observed, read-only environments panel: what a hive reports about its
// tenant's environments. Platform Admin only observes tenant data, so this
// view-model carries rows and nothing else: no commands.
export class ObservedEnvironmentsViewModel extends Observable
{
    private readonly rows = new ObservableCollection<ObservedEnvironmentRowViewModel>()

    public constructor(envs: readonly FleetEnvDto[])
    {
        super()
        for (const env of envs)
        {
            this.rows.Add(new ObservedEnvironmentRowViewModel(env))
        }
    }

    public get Rows(): ObservableCollection<ObservedEnvironmentRowViewModel>
    {
        return this.rows
    }

    public get HasRows(): boolean
    {
        return this.rows.Count > 0
    }

    public get IsEmpty(): boolean
    {
        return this.rows.Count === 0
    }
}
