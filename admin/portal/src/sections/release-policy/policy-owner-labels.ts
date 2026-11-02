import type { ClientDto, TenantDto } from '../../portal-types.js'

// Names a tenant as "Client / Tenant" (or just the tenant when its client is
// unknown), for policy rules, gated versions and the gate dialog.
export class PolicyOwnerLabels
{
    private static readonly Separator = ' / '
    private static readonly UnknownLabel = '(unknown tenant)'

    private readonly tenants: ReadonlyMap<string, TenantDto>
    private readonly clients: ReadonlyMap<string, ClientDto>

    public constructor(tenants: readonly TenantDto[], clients: readonly ClientDto[])
    {
        this.tenants = new Map(tenants.map(t => [t.id, t]))
        this.clients = new Map(clients.map(c => [c.id, c]))
    }

    public For(tenantId: string): string
    {
        const tenant = this.tenants.get(tenantId)
        if (tenant === undefined)
        {
            return PolicyOwnerLabels.UnknownLabel
        }
        const client = this.clients.get(tenant.clientId)
        return client === undefined ? tenant.displayName : client.displayName + PolicyOwnerLabels.Separator + tenant.displayName
    }
}
