import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { HiveDto } from './portal-types.js'

// The slice of ControlPlaneClient the hive list needs.
export interface IHiveListSource
{
    ListHives(tenantId?: string): Promise<HiveDto[]>
    DeleteHive(id: string): Promise<void>
}

// Hive list state for one tenant.
export class HiveListViewModel extends Observable
{
    public static readonly HivesProperty = 'Hives'

    private hives: readonly HiveDto[] = []

    public constructor(private readonly source: IHiveListSource, public readonly TenantId: string)
    {
        super()
    }

    public get Hives(): readonly HiveDto[]
    {
        return this.hives
    }

    public async Load(): Promise<void>
    {
        const old = this.hives
        this.hives = await this.source.ListHives(this.TenantId)
        this.RaisePropertyChanged(HiveListViewModel.HivesProperty, old, this.hives)
    }

    public async Delete(id: string): Promise<void>
    {
        await this.source.DeleteHive(id)
    }
}
