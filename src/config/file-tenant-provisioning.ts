import { DataSourceKind } from '@pragmatic-tech-ai/todl'
import { ConnectorsPolicy } from '../host/connector-policy.js'
import type { ITenantProvisioning, TenantProvisioning } from '../tenancy/tenant-provisioning.js'

interface PolicyShape
{
    adapterAllowlist: readonly string[]
    catalogOnly: boolean
    allowProviderOverride: boolean
    providerAllowlist: readonly string[]
}

interface TenantShape
{
    displayName: string
    bootstrap?: TenantProvisioning['bootstrap']
    oidc?: TenantProvisioning['oidc']
    connectorsPolicy?: PolicyShape
}

interface FileShape
{
    tenants: Record<string, TenantShape>
}

export class FileTenantProvisioning implements ITenantProvisioning
{
    private static readonly BadJson = 'tenants file is not valid JSON'
    private static readonly BadKind = 'unknown adapter kind in tenants file'

    private readonly entries: ReadonlyMap<string, TenantProvisioning>

    private constructor(entries: ReadonlyMap<string, TenantProvisioning>)
    {
        this.entries = entries
    }

    public static FromText(json: string): FileTenantProvisioning
    {
        const parsed = FileTenantProvisioning.Parse(json)
        const entries = new Map<string, TenantProvisioning>()
        for (const [id, shape] of Object.entries(parsed.tenants))
        {
            entries.set(id, FileTenantProvisioning.Provisioning(shape))
        }
        return new FileTenantProvisioning(entries)
    }

    public OptionsFor(tenantId: string): TenantProvisioning | null
    {
        return this.entries.get(tenantId) ?? null
    }

    private static Parse(json: string): FileShape
    {
        try
        {
            return JSON.parse(json) as FileShape
        }
        catch
        {
            throw new Error(FileTenantProvisioning.BadJson)
        }
    }

    private static Provisioning(shape: TenantShape): TenantProvisioning
    {
        return {
            displayName: shape.displayName,
            bootstrap: shape.bootstrap,
            oidc: shape.oidc,
            connectorsPolicy: shape.connectorsPolicy === undefined ? undefined : FileTenantProvisioning.Policy(shape.connectorsPolicy),
        }
    }

    private static Policy(shape: PolicyShape): ConnectorsPolicy
    {
        const kinds = shape.adapterAllowlist.map(name => FileTenantProvisioning.Kind(name))
        return new ConnectorsPolicy(kinds, shape.catalogOnly, shape.allowProviderOverride, shape.providerAllowlist)
    }

    private static Kind(name: string): DataSourceKind
    {
        const match = Object.values(DataSourceKind).find(kind => kind === name)
        if (match === undefined)
        {
            throw new Error(FileTenantProvisioning.BadKind)
        }
        return match
    }
}
