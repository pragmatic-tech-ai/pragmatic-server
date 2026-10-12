import { DataSourceKind } from '@pragmatic-tech-ai/todl'
import { ConnectorsPolicy } from '../host/connector-policy.js'
import { FileConnectionResolver } from '../host/file-connection-resolver.js'
import type { FileConnection } from '../host/file-connection-resolver.js'
import type { ITenantProvisioning, TenantProvisioning } from '../tenancy/tenant-provisioning.js'

interface PolicyShape
{
    adapterAllowlist: readonly string[]
    catalogOnly: boolean
    allowProviderOverride: boolean
    providerAllowlist: readonly string[]
}

interface ConnectionShape
{
    settings: Record<string, string>
    secretRef?: string
    tokenEnvVar?: string
}

interface TenantShape
{
    displayName: string
    bootstrap?: TenantProvisioning['bootstrap']
    oidc?: TenantProvisioning['oidc']
    connectorsPolicy?: PolicyShape
    connections?: Record<string, ConnectionShape>
}

interface FileShape
{
    tenants: Record<string, TenantShape>
}

export class FileTenantProvisioning implements ITenantProvisioning
{
    private static readonly BadJson = 'tenants file is not valid JSON'
    private static readonly BadShape = 'tenants file has an invalid shape'
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

    public Count(): number
    {
        return this.entries.size
    }

    private static Parse(json: string): FileShape
    {
        let parsed: unknown
        try
        {
            parsed = JSON.parse(json)
        }
        catch
        {
            throw new Error(FileTenantProvisioning.BadJson)
        }
        if (!FileTenantProvisioning.IsRecord(parsed) || !FileTenantProvisioning.IsRecord(parsed.tenants))
        {
            throw new Error(FileTenantProvisioning.BadShape)
        }
        return parsed as unknown as FileShape
    }

    private static IsRecord(value: unknown): value is Record<string, unknown>
    {
        return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    private static Provisioning(shape: TenantShape): TenantProvisioning
    {
        const connections = FileTenantProvisioning.Connections(shape)
        return {
            displayName: shape.displayName,
            bootstrap: shape.bootstrap,
            oidc: shape.oidc,
            connectorsPolicy: shape.connectorsPolicy === undefined ? undefined : FileTenantProvisioning.Policy(shape.connectorsPolicy),
            connectors: connections === undefined ? undefined : { connectionResolver: connections.Resolver },
            connectorSecretRefs: connections === undefined ? undefined : connections.Refs,
        }
    }

    private static Connections(shape: TenantShape): { Resolver: FileConnectionResolver; Refs: readonly string[] } | undefined
    {
        if (shape.connections === undefined)
        {
            return undefined
        }
        if (!FileTenantProvisioning.IsRecord(shape.connections))
        {
            throw new Error(FileTenantProvisioning.BadShape)
        }
        const map = new Map<string, FileConnection>()
        const refs: string[] = []
        for (const [id, entry] of Object.entries(shape.connections))
        {
            map.set(id, FileTenantProvisioning.Connection(entry))
            if (entry.secretRef !== undefined && entry.secretRef.length > 0 && !refs.includes(entry.secretRef))
            {
                refs.push(entry.secretRef)
            }
        }
        return { Resolver: new FileConnectionResolver(map), Refs: refs }
    }

    private static Connection(entry: ConnectionShape): FileConnection
    {
        if (!FileTenantProvisioning.IsRecord(entry) || !FileTenantProvisioning.IsRecord(entry.settings))
        {
            throw new Error(FileTenantProvisioning.BadShape)
        }
        for (const value of Object.values(entry.settings))
        {
            if (typeof value !== 'string')
            {
                throw new Error(FileTenantProvisioning.BadShape)
            }
        }
        if (entry.secretRef !== undefined && typeof entry.secretRef !== 'string')
        {
            throw new Error(FileTenantProvisioning.BadShape)
        }
        if (entry.tokenEnvVar !== undefined && typeof entry.tokenEnvVar !== 'string')
        {
            throw new Error(FileTenantProvisioning.BadShape)
        }
        return {
            Settings: entry.settings,
            SecretRef: entry.secretRef,
            TokenEnvVar: entry.tokenEnvVar,
        }
    }

    private static Policy(shape: PolicyShape): ConnectorsPolicy
    {
        if (!Array.isArray(shape.adapterAllowlist) || !Array.isArray(shape.providerAllowlist))
        {
            throw new Error(FileTenantProvisioning.BadShape)
        }
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
