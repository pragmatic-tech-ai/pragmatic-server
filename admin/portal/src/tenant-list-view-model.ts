import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { TenantDto } from './portal-types.js'

// The slice of ControlPlaneClient the tenant list needs.
export interface ITenantListSource
{
    ListTenants(clientId?: string): Promise<TenantDto[]>
    DeleteTenant(id: string): Promise<void>
}

// Tenant list state for one client.
export class TenantListViewModel extends Observable
{
    public static readonly TenantsProperty = 'Tenants'

    private tenants: readonly TenantDto[] = []

    public constructor(private readonly source: ITenantListSource, public readonly ClientId: string)
    {
        super()
    }

    public get Tenants(): readonly TenantDto[]
    {
        return this.tenants
    }

    public async Load(): Promise<void>
    {
        const old = this.tenants
        this.tenants = await this.source.ListTenants(this.ClientId)
        this.RaisePropertyChanged(TenantListViewModel.TenantsProperty, old, this.tenants)
    }

    public async Delete(id: string): Promise<void>
    {
        await this.source.DeleteTenant(id)
    }
}
