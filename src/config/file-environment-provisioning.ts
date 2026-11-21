import { DataSourceKind } from '@pragmatic-tech-ai/todl'
import { DelegationDepth, IdentityConfig, Role } from '@pragmatic-tech-ai/pragmatic-identity'
import { OidcSettingKeys } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { MachinePrincipalMap, type MachinePrincipalEntry } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import { ConnectorsPolicy } from '../host/connector-policy.js'
import { FileConnectionResolver, type FileConnection } from '../host/file-connection-resolver.js'
import { EnvironmentPurpose } from '../environments/environment-purpose.js'
import type { IEnvironmentProvisioning, EnvironmentProvisioning } from '../environments/environment-provisioning.js'

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

interface EnvironmentShape
{
    identity?: IdentityShape
    displayName: string
    purpose?: EnvironmentPurpose | string
    bootstrap?: EnvironmentProvisioning['bootstrap']
    oidc?: EnvironmentProvisioning['oidc']
    connectorsPolicy?: PolicyShape
    connections?: Record<string, ConnectionShape>
}

interface FileShape
{
    environments: Record<string, EnvironmentShape>
}

export class FileEnvironmentProvisioning implements IEnvironmentProvisioning
{
    private static readonly EnvironmentsKey = 'environments'
    private static readonly BadPurpose = 'environments file has an invalid purpose (expected an EnvironmentPurpose value)'
    private static readonly BadJson = 'environments file is not valid JSON'
    private static readonly BadShape = 'environments file has an invalid shape'
    private static readonly BadKind = 'unknown adapter kind in environments file'
    private static readonly BadIdentityField = 'environments file has an invalid identity field: '
    private static readonly BadDepth = 'unknown delegationDepth in environments file identity'
    private static readonly BadRole = 'unknown role in environments file identity groupRoleMap'
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
    private static readonly PurposeNames: ReadonlyMap<string, EnvironmentPurpose> = FileEnvironmentProvisioning.BuildPurposeNames()

    private readonly entries: ReadonlyMap<string, EnvironmentProvisioning>

    private constructor(entries: ReadonlyMap<string, EnvironmentProvisioning>)
    {
        this.entries = entries
    }

    public static FromText(json: string): FileEnvironmentProvisioning
    {
        const parsed = FileEnvironmentProvisioning.Parse(json)
        const entries = new Map<string, EnvironmentProvisioning>()
        for (const [id, shape] of Object.entries(parsed.environments))
        {
            entries.set(id, FileEnvironmentProvisioning.Provisioning(shape))
        }
        return new FileEnvironmentProvisioning(entries)
    }

    public OptionsFor(environmentId: string): EnvironmentProvisioning | null
    {
        return this.entries.get(environmentId) ?? null
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
            throw new Error(FileEnvironmentProvisioning.BadJson)
        }
        if (!FileEnvironmentProvisioning.IsRecord(parsed))
        {
            throw new Error(FileEnvironmentProvisioning.BadShape)
        }
        const environments = parsed[FileEnvironmentProvisioning.EnvironmentsKey]
        if (!FileEnvironmentProvisioning.IsRecord(environments))
        {
            throw new Error(FileEnvironmentProvisioning.BadShape)
        }
        return { environments: environments as Record<string, EnvironmentShape> }
    }

    private static IsRecord(value: unknown): value is Record<string, unknown>
    {
        return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    private static Provisioning(shape: EnvironmentShape): EnvironmentProvisioning
    {
        const connections = FileEnvironmentProvisioning.Connections(shape)
        const identity = shape.identity === undefined ? FileEnvironmentProvisioning.LegacyIdentity(shape.oidc) : FileEnvironmentProvisioning.Identity(shape.identity)
        return {
            displayName: shape.displayName,
            purpose: FileEnvironmentProvisioning.Purpose(shape.purpose),
            bootstrap: shape.bootstrap,
            oidc: shape.oidc,
            connectorsPolicy: shape.connectorsPolicy === undefined ? undefined : FileEnvironmentProvisioning.Policy(shape.connectorsPolicy),
            connectors: connections === undefined ? undefined : { connectionResolver: connections.Resolver },
            connectorSecretRefs: connections === undefined ? undefined : connections.Refs,
            identity,
            machine: shape.identity === undefined ? undefined : FileEnvironmentProvisioning.Machine(shape.identity.machine),
        }
    }

    private static BuildPurposeNames(): ReadonlyMap<string, EnvironmentPurpose>
    {
        const names = new Map<string, EnvironmentPurpose>()
        for (const key of Object.keys(EnvironmentPurpose))
        {
            const mapped = (EnvironmentPurpose as unknown as Record<string, unknown>)[key]
            if (typeof mapped === 'number') names.set(key, mapped as EnvironmentPurpose)
        }
        return names
    }

    private static Purpose(value: unknown): EnvironmentPurpose | undefined
    {
        if (value === undefined) return undefined
        if (typeof value === 'number' && EnvironmentPurpose[value] !== undefined)
        {
            return value as EnvironmentPurpose
        }
        if (typeof value === 'string')
        {
            const named = FileEnvironmentProvisioning.PurposeNames.get(value)
            if (named !== undefined) return named
        }
        throw new Error(FileEnvironmentProvisioning.BadPurpose)
    }

    private static LegacyIdentity(oidc: EnvironmentShape['oidc']): IdentityConfig | undefined
    {
        if (oidc === undefined)
        {
            return undefined
        }
        const settings = new Map<string, string>([
            [OidcSettingKeys.Issuer, FileEnvironmentProvisioning.OidcField(oidc, FileEnvironmentProvisioning.OidcIssuer)],
            [OidcSettingKeys.DiscoveryUrl, FileEnvironmentProvisioning.OidcField(oidc, FileEnvironmentProvisioning.OidcDiscoveryUrl)],
            [OidcSettingKeys.ClientId, FileEnvironmentProvisioning.OidcField(oidc, FileEnvironmentProvisioning.OidcClientId)],
            [OidcSettingKeys.RedirectUri, FileEnvironmentProvisioning.OidcField(oidc, FileEnvironmentProvisioning.OidcRedirectUri)],
            [OidcSettingKeys.SecretRef, FileEnvironmentProvisioning.OidcField(oidc, FileEnvironmentProvisioning.OidcClientSecretRef)],
        ])
        return new IdentityConfig(FileEnvironmentProvisioning.LegacyPackId, DelegationDepth.AuthnDirectory, settings, new Map(), new Map())
    }

    private static OidcField(oidc: unknown, key: 'issuer' | 'discoveryUrl' | 'clientId' | 'redirectUri' | 'clientSecretRef'): string
    {
        const value = FileEnvironmentProvisioning.IsRecord(oidc) ? oidc[key] : undefined
        if (typeof value !== 'string' || value.length === 0)
        {
            throw FileEnvironmentProvisioning.BadField(FileEnvironmentProvisioning.OidcFieldPrefix + key)
        }
        return value
    }

    private static Identity(shape: IdentityShape): IdentityConfig
    {
        if (!FileEnvironmentProvisioning.IsRecord(shape) || typeof shape.pack !== 'string' || shape.pack.length === 0)
        {
            throw FileEnvironmentProvisioning.BadField(FileEnvironmentProvisioning.FieldPack)
        }
        if (shape.delegationDepth !== undefined && typeof shape.delegationDepth !== 'string')
        {
            throw FileEnvironmentProvisioning.BadField(FileEnvironmentProvisioning.FieldDelegationDepth)
        }
        const depth = FileEnvironmentProvisioning.Depth(shape.delegationDepth)
        const settings = FileEnvironmentProvisioning.StringMap(shape.providerSettings, FileEnvironmentProvisioning.FieldProviderSettings)
        const claims = FileEnvironmentProvisioning.StringMap(shape.claimsMapping, FileEnvironmentProvisioning.FieldClaimsMapping)
        const roles = new Map<string, Role>()
        for (const [group, role] of FileEnvironmentProvisioning.StringMap(shape.groupRoleMap, FileEnvironmentProvisioning.FieldGroupRoleMap))
        {
            roles.set(group, FileEnvironmentProvisioning.RoleOf(role))
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
        if (!FileEnvironmentProvisioning.IsRecord(value))
        {
            throw FileEnvironmentProvisioning.BadField(field)
        }
        for (const [key, entry] of Object.entries(value))
        {
            if (typeof entry !== 'string')
            {
                throw FileEnvironmentProvisioning.BadField(field)
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
        if (!FileEnvironmentProvisioning.IsRecord(record))
        {
            throw FileEnvironmentProvisioning.BadField(FileEnvironmentProvisioning.FieldMachine)
        }
        const entries = new Map<string, MachinePrincipalEntry>()
        for (const [fingerprint, entry] of Object.entries(record))
        {
            if (!FileEnvironmentProvisioning.IsRecord(entry) || typeof entry.principalId !== 'string' || entry.principalId.length === 0)
            {
                throw FileEnvironmentProvisioning.BadField(FileEnvironmentProvisioning.FieldPrincipalId)
            }
            if (entry.groups !== undefined && (!Array.isArray(entry.groups) || entry.groups.some(group => typeof group !== 'string')))
            {
                throw FileEnvironmentProvisioning.BadField(FileEnvironmentProvisioning.FieldMachineGroups)
            }
            entries.set(fingerprint, { PrincipalId: entry.principalId, Groups: entry.groups ?? [] })
        }
        return new MachinePrincipalMap(entries)
    }

    private static BadField(field: string): Error
    {
        return new Error(FileEnvironmentProvisioning.BadIdentityField + field)
    }

    private static Depth(name: string | undefined): DelegationDepth
    {
        switch (name)
        {
            case undefined:
            case FileEnvironmentProvisioning.DepthAuthnDirectory:
                return DelegationDepth.AuthnDirectory
            case FileEnvironmentProvisioning.DepthExternalGrants:
                return DelegationDepth.ExternalGrants
            case FileEnvironmentProvisioning.DepthFullAuthz:
                return DelegationDepth.FullAuthz
            default:
                throw new Error(FileEnvironmentProvisioning.BadDepth)
        }
    }

    private static RoleOf(name: string): Role
    {
        switch (name)
        {
            case FileEnvironmentProvisioning.RoleViewer:
                return Role.Viewer
            case FileEnvironmentProvisioning.RoleEditor:
                return Role.Editor
            case FileEnvironmentProvisioning.RoleAdmin:
                return Role.Admin
            case FileEnvironmentProvisioning.RoleOwner:
                return Role.Owner
            default:
                throw new Error(FileEnvironmentProvisioning.BadRole)
        }
    }

    private static Connections(shape: EnvironmentShape): { Resolver: FileConnectionResolver; Refs: readonly string[] } | undefined
    {
        if (shape.connections === undefined)
        {
            return undefined
        }
        if (!FileEnvironmentProvisioning.IsRecord(shape.connections))
        {
            throw new Error(FileEnvironmentProvisioning.BadShape)
        }
        const map = new Map<string, FileConnection>()
        const refs: string[] = []
        for (const [id, entry] of Object.entries(shape.connections))
        {
            map.set(id, FileEnvironmentProvisioning.Connection(entry))
            if (entry.secretRef !== undefined && entry.secretRef.length > 0 && !refs.includes(entry.secretRef))
            {
                refs.push(entry.secretRef)
            }
        }
        return { Resolver: new FileConnectionResolver(map), Refs: refs }
    }

    private static Connection(entry: ConnectionShape): FileConnection
    {
        if (!FileEnvironmentProvisioning.IsRecord(entry) || !FileEnvironmentProvisioning.IsRecord(entry.settings))
        {
            throw new Error(FileEnvironmentProvisioning.BadShape)
        }
        for (const value of Object.values(entry.settings))
        {
            if (typeof value !== 'string')
            {
                throw new Error(FileEnvironmentProvisioning.BadShape)
            }
        }
        if (entry.secretRef !== undefined && typeof entry.secretRef !== 'string')
        {
            throw new Error(FileEnvironmentProvisioning.BadShape)
        }
        if (entry.tokenEnvVar !== undefined && typeof entry.tokenEnvVar !== 'string')
        {
            throw new Error(FileEnvironmentProvisioning.BadShape)
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
            throw new Error(FileEnvironmentProvisioning.BadShape)
        }
        const kinds = shape.adapterAllowlist.map(name => FileEnvironmentProvisioning.Kind(name))
        return new ConnectorsPolicy(kinds, shape.catalogOnly, shape.allowProviderOverride, shape.providerAllowlist)
    }

    private static Kind(name: string): DataSourceKind
    {
        const match = Object.values(DataSourceKind).find(kind => kind === name)
        if (match === undefined)
        {
            throw new Error(FileEnvironmentProvisioning.BadKind)
        }
        return match
    }
}
