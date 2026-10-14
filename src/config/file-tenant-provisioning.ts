import { DataSourceKind } from '@pragmatic-tech-ai/todl'
import { DelegationDepth, IdentityConfig, Role } from '@pragmatic-tech-ai/todl-identity'
import { OidcSettingKeys } from '@pragmatic-tech-ai/todl-identity-cloud'
import { MachinePrincipalMap } from '../host/machine-principal-map.js'
import type { MachinePrincipalEntry } from '../host/machine-principal-map.js'
import { ConnectorsPolicy } from '../host/connector-policy.js'
import { FileConnectionResolver } from '../host/file-connection-resolver.js'
import type { FileConnection } from '../host/file-connection-resolver.js'
import { TenantPurpose } from '../tenancy/tenant-purpose.js'
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

interface MachineShape
{
    principalId: string
    groups?: string[]
}

interface IdentityShape
{
    pack: string
    delegationDepth?: string
    providerSettings?: Record<string, string>
    claimsMapping?: Record<string, string>
    groupRoleMap?: Record<string, string>
    machine?: Record<string, MachineShape>
}

interface TenantShape
{
    identity?: IdentityShape
    displayName: string
    purpose?: TenantPurpose
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
    private static readonly BadPurpose = 'tenants file has an invalid purpose (expected a TenantPurpose value)'
    private static readonly BadJson = 'tenants file is not valid JSON'
    private static readonly BadShape = 'tenants file has an invalid shape'
    private static readonly BadKind = 'unknown adapter kind in tenants file'
    private static readonly BadIdentityField = 'tenants file has an invalid identity field: '
    private static readonly BadDepth = 'unknown delegationDepth in tenants file identity'
    private static readonly BadRole = 'unknown role in tenants file identity groupRoleMap'
    private static readonly FieldPack = 'pack'
    private static readonly FieldDelegationDepth = 'delegationDepth'
    private static readonly FieldProviderSettings = 'providerSettings'
    private static readonly FieldClaimsMapping = 'claimsMapping'
    private static readonly FieldGroupRoleMap = 'groupRoleMap'
    private static readonly FieldMachine = 'machine'
    private static readonly FieldPrincipalId = 'machine.principalId'
    private static readonly FieldMachineGroups = 'machine.groups'
    private static readonly OidcFieldPrefix = 'oidc.'
    private static readonly OidcIssuer = 'issuer'
    private static readonly OidcDiscoveryUrl = 'discoveryUrl'
    private static readonly OidcClientId = 'clientId'
    private static readonly OidcRedirectUri = 'redirectUri'
    private static readonly OidcClientSecretRef = 'clientSecretRef'
    private static readonly LegacyPackId = 'generic-oidc'
    private static readonly DepthAuthnDirectory = 'authn-directory'
    private static readonly DepthExternalGrants = 'external-grants'
    private static readonly DepthFullAuthz = 'full-authz'
    private static readonly RoleViewer = 'viewer'
    private static readonly RoleEditor = 'editor'
    private static readonly RoleAdmin = 'admin'
    private static readonly RoleOwner = 'owner'

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
        const identity = shape.identity === undefined ? FileTenantProvisioning.LegacyIdentity(shape.oidc) : FileTenantProvisioning.Identity(shape.identity)
        return {
            displayName: shape.displayName,
            purpose: FileTenantProvisioning.Purpose(shape.purpose),
            bootstrap: shape.bootstrap,
            oidc: shape.oidc,
            connectorsPolicy: shape.connectorsPolicy === undefined ? undefined : FileTenantProvisioning.Policy(shape.connectorsPolicy),
            connectors: connections === undefined ? undefined : { connectionResolver: connections.Resolver },
            connectorSecretRefs: connections === undefined ? undefined : connections.Refs,
            identity,
            machine: shape.identity === undefined ? undefined : FileTenantProvisioning.Machine(shape.identity.machine),
        }
    }

    private static Purpose(value: unknown): TenantPurpose | undefined
    {
        if (value === undefined) return undefined
        if (typeof value !== 'number' || TenantPurpose[value] === undefined)
        {
            throw new Error(FileTenantProvisioning.BadPurpose)
        }
        return value as TenantPurpose
    }

    private static LegacyIdentity(oidc: TenantShape['oidc']): IdentityConfig | undefined
    {
        if (oidc === undefined)
        {
            return undefined
        }
        const settings = new Map<string, string>([
            [OidcSettingKeys.Issuer, FileTenantProvisioning.OidcField(oidc, FileTenantProvisioning.OidcIssuer)],
            [OidcSettingKeys.DiscoveryUrl, FileTenantProvisioning.OidcField(oidc, FileTenantProvisioning.OidcDiscoveryUrl)],
            [OidcSettingKeys.ClientId, FileTenantProvisioning.OidcField(oidc, FileTenantProvisioning.OidcClientId)],
            [OidcSettingKeys.RedirectUri, FileTenantProvisioning.OidcField(oidc, FileTenantProvisioning.OidcRedirectUri)],
            [OidcSettingKeys.SecretRef, FileTenantProvisioning.OidcField(oidc, FileTenantProvisioning.OidcClientSecretRef)],
        ])
        return new IdentityConfig(FileTenantProvisioning.LegacyPackId, DelegationDepth.AuthnDirectory, settings, new Map(), new Map())
    }

    private static OidcField(oidc: unknown, key: 'issuer' | 'discoveryUrl' | 'clientId' | 'redirectUri' | 'clientSecretRef'): string
    {
        const value = FileTenantProvisioning.IsRecord(oidc) ? oidc[key] : undefined
        if (typeof value !== 'string' || value.length === 0)
        {
            throw FileTenantProvisioning.BadField(FileTenantProvisioning.OidcFieldPrefix + key)
        }
        return value
    }

    private static Identity(shape: IdentityShape): IdentityConfig
    {
        if (!FileTenantProvisioning.IsRecord(shape) || typeof shape.pack !== 'string' || shape.pack.length === 0)
        {
            throw FileTenantProvisioning.BadField(FileTenantProvisioning.FieldPack)
        }
        if (shape.delegationDepth !== undefined && typeof shape.delegationDepth !== 'string')
        {
            throw FileTenantProvisioning.BadField(FileTenantProvisioning.FieldDelegationDepth)
        }
        const depth = FileTenantProvisioning.Depth(shape.delegationDepth)
        const settings = FileTenantProvisioning.StringMap(shape.providerSettings, FileTenantProvisioning.FieldProviderSettings)
        const claims = FileTenantProvisioning.StringMap(shape.claimsMapping, FileTenantProvisioning.FieldClaimsMapping)
        const roles = new Map<string, Role>()
        for (const [group, role] of FileTenantProvisioning.StringMap(shape.groupRoleMap, FileTenantProvisioning.FieldGroupRoleMap))
        {
            roles.set(group, FileTenantProvisioning.RoleOf(role))
        }
        return new IdentityConfig(shape.pack, depth, settings, roles, claims)
    }

    private static StringMap(value: unknown, field: string): Map<string, string>
    {
        const result = new Map<string, string>()
        if (value === undefined)
        {
            return result
        }
        if (!FileTenantProvisioning.IsRecord(value))
        {
            throw FileTenantProvisioning.BadField(field)
        }
        for (const [key, entry] of Object.entries(value))
        {
            if (typeof entry !== 'string')
            {
                throw FileTenantProvisioning.BadField(field)
            }
            result.set(key, entry)
        }
        return result
    }

    private static Machine(record: Record<string, MachineShape> | undefined): MachinePrincipalMap | undefined
    {
        if (record === undefined)
        {
            return undefined
        }
        if (!FileTenantProvisioning.IsRecord(record))
        {
            throw FileTenantProvisioning.BadField(FileTenantProvisioning.FieldMachine)
        }
        const entries = new Map<string, MachinePrincipalEntry>()
        for (const [fingerprint, entry] of Object.entries(record))
        {
            if (!FileTenantProvisioning.IsRecord(entry) || typeof entry.principalId !== 'string' || entry.principalId.length === 0)
            {
                throw FileTenantProvisioning.BadField(FileTenantProvisioning.FieldPrincipalId)
            }
            if (entry.groups !== undefined && (!Array.isArray(entry.groups) || entry.groups.some(group => typeof group !== 'string')))
            {
                throw FileTenantProvisioning.BadField(FileTenantProvisioning.FieldMachineGroups)
            }
            entries.set(fingerprint, { PrincipalId: entry.principalId, Groups: entry.groups ?? [] })
        }
        return new MachinePrincipalMap(entries)
    }

    private static BadField(field: string): Error
    {
        return new Error(FileTenantProvisioning.BadIdentityField + field)
    }

    private static Depth(name: string | undefined): DelegationDepth
    {
        switch (name)
        {
            case undefined:
            case FileTenantProvisioning.DepthAuthnDirectory:
                return DelegationDepth.AuthnDirectory
            case FileTenantProvisioning.DepthExternalGrants:
                return DelegationDepth.ExternalGrants
            case FileTenantProvisioning.DepthFullAuthz:
                return DelegationDepth.FullAuthz
            default:
                throw new Error(FileTenantProvisioning.BadDepth)
        }
    }

    private static RoleOf(name: string): Role
    {
        switch (name)
        {
            case FileTenantProvisioning.RoleViewer:
                return Role.Viewer
            case FileTenantProvisioning.RoleEditor:
                return Role.Editor
            case FileTenantProvisioning.RoleAdmin:
                return Role.Admin
            case FileTenantProvisioning.RoleOwner:
                return Role.Owner
            default:
                throw new Error(FileTenantProvisioning.BadRole)
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
            Settings: { ...entry.settings },
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
