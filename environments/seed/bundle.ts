import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DelegationDepth } from '@pragmatic-tech-ai/todl-identity'
import { OidcSettingKeys } from '@pragmatic-tech-ai/todl-identity-cloud'
import { NorthwindApp } from './compile.js'

export enum EnvKind
{
    Dev = 'dev',
    Demo = 'demo',
}

/** The numeric TenantPurpose serialized into tenants.json (Development = 0, Runtime = 1). */
export enum TenantPurposeName
{
    Development = '0',
    Runtime = '1',
}

export type EnvDatabase = { connectionName: string; host: string; port: number; database: string; user: string; password: string; hostPort: number }
/** Tenant-IdP federation input: provider settings for the generic-oidc pack plus the raw client secret stored under secretRef. */
export type EnvOidc = { issuer: string; discoveryUrl: string; clientId: string; redirectUri: string; secretRef: string; secret: string }
export type EnvDefinition = { name: string; kind: EnvKind; environmentId: string; purpose: TenantPurposeName; hostPort: number; database?: EnvDatabase }

/** Generates a pragmatic-server config bundle (master key, secrets, tenants, tenant config, demo app) for one environment. */
export class BundleBuilder
{
    private static readonly MasterKeyFile = 'master.key'
    private static readonly SecretsFile = 'provisioned-secrets.json'
    private static readonly TenantsFile = 'tenants.json'
    private static readonly TenantConfigFile = 'tenant-config.json'
    private static readonly ApplicationFile = 'application.json'
    private static readonly SecurityModelFile = 'security-model.json'
    private static readonly UsersFile = 'users.json'
    private static readonly DataDir = 'data'
    private static readonly SeedDir = 'seed'
    private static readonly IdentityDir = 'identity'
    private static readonly PackagesDir = 'packages'
    private static readonly ApplicationsDir = 'applications'
    public static readonly AdminSecretSuffix = '-admin-pw'
    private static readonly PrincipalSecretSuffix = '-pw'
    private static readonly AdminPrincipalId = 'admin'
    public static readonly AdminEmailPrefix = 'admin@'
    public static readonly AdminEmailSuffix = '.test'
    private static readonly LocalPackId = 'local'
    private static readonly GenericOidcPackId = 'generic-oidc'
    private static readonly Utf8 = 'utf8'
    private static readonly HexEncoding = 'hex'
    private static readonly Newline = '\n'
    private static readonly BadUserEntryPrefix = 'users.json entry missing principalId: '
    private static readonly SqlAdapter = 'sql'
    private static readonly PathSep = '/'
    private static readonly DbSecretSuffix = '/password'
    private static readonly KeyBytes = 32
    private static readonly SecretBytes = 24
    private static readonly FullAuthzDepth = 2
    private static readonly Indent = 2
    private static readonly SeedRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

    public static async Generate(def: EnvDefinition, bundleDir: string, explicitSeedDir?: string, oidc?: EnvOidc): Promise<void>
    {
        mkdirSync(bundleDir, { recursive: true })
        const seedDir = explicitSeedDir ?? join(BundleBuilder.SeedRoot, def.name, BundleBuilder.SeedDir)
        BundleBuilder.WriteMasterKey(bundleDir)
        BundleBuilder.WriteSecrets(def, bundleDir, seedDir, oidc)
        BundleBuilder.WriteTenants(def, bundleDir)
        const tenantDir = join(bundleDir, BundleBuilder.DataDir, def.environmentId)
        BundleBuilder.WriteTenantConfig(def, tenantDir, seedDir, oidc)
        if (def.kind === EnvKind.Demo)
        {
            await BundleBuilder.WriteDemoApplication(tenantDir)
        }
    }

    private static WriteMasterKey(bundleDir: string): void
    {
        const path = join(bundleDir, BundleBuilder.MasterKeyFile)
        if (!existsSync(path))
        {
            writeFileSync(path, randomBytes(BundleBuilder.KeyBytes))
        }
    }

    private static WriteSecrets(def: EnvDefinition, bundleDir: string, seedDir: string, oidc?: EnvOidc): void
    {
        const path = join(bundleDir, BundleBuilder.SecretsFile)
        if (existsSync(path))
        {
            return
        }
        const secrets: Record<string, string> = {}
        secrets[def.environmentId + BundleBuilder.AdminSecretSuffix] = BundleBuilder.RandomSecret()
        for (const principalId of BundleBuilder.UserPrincipals(seedDir))
        {
            secrets[principalId + BundleBuilder.PrincipalSecretSuffix] = BundleBuilder.RandomSecret()
        }
        if (def.database)
        {
            secrets[BundleBuilder.DbSecretRef(def, def.database)] = def.database.password
        }
        if (oidc)
        {
            secrets[oidc.secretRef] = oidc.secret
        }
        BundleBuilder.WriteJson(path, secrets)
    }

    public static DbSecretRef(def: EnvDefinition, db: EnvDatabase): string
    {
        return def.environmentId + BundleBuilder.PathSep + db.connectionName + BundleBuilder.DbSecretSuffix
    }

    private static UserPrincipals(seedDir: string): string[]
    {
        const path = join(seedDir, BundleBuilder.UsersFile)
        if (!existsSync(path))
        {
            return []
        }
        const list = JSON.parse(readFileSync(path, BundleBuilder.Utf8)) as { principalId?: unknown }[]
        return list.map(entry =>
        {
            if (typeof entry?.principalId !== 'string' || entry.principalId === '')
            {
                throw new Error(BundleBuilder.BadUserEntryPrefix + JSON.stringify(entry))
            }
            return entry.principalId
        })
    }

    private static WriteTenants(def: EnvDefinition, bundleDir: string): void
    {
        const tenants: Record<string, unknown> = {}
        const tenant: Record<string, unknown> = {
            displayName: def.environmentId,
            purpose: Number(def.purpose),
            bootstrap: {
                adminEmail: BundleBuilder.AdminEmailPrefix + def.environmentId + BundleBuilder.AdminEmailSuffix,
                adminPrincipalId: BundleBuilder.AdminPrincipalId,
                adminPasswordRef: def.environmentId + BundleBuilder.AdminSecretSuffix,
                ownerGrant: true,
            },
            connectorsPolicy: { adapterAllowlist: [], catalogOnly: true, allowProviderOverride: false, providerAllowlist: [] },
        }
        if (def.database)
        {
            const db = def.database
            const policy = tenant.connectorsPolicy as { adapterAllowlist: string[] }
            policy.adapterAllowlist = [BundleBuilder.SqlAdapter]
            const connections: Record<string, unknown> = {}
            connections[db.connectionName] = { settings: { host: db.host, port: String(db.port), database: db.database, user: db.user }, secretRef: BundleBuilder.DbSecretRef(def, db) }
            tenant.connections = connections
        }
        tenants[def.environmentId] = tenant
        BundleBuilder.WriteJson(join(bundleDir, BundleBuilder.TenantsFile), { tenants })
    }

    /** Matches FileTenantConfigStore: { configs: { <environmentId>: record } }, Map fields serialized as entry arrays. */
    private static WriteTenantConfig(def: EnvDefinition, tenantDir: string, seedDir: string, oidc?: EnvOidc): void
    {
        const identityDir = join(tenantDir, BundleBuilder.IdentityDir)
        mkdirSync(identityDir, { recursive: true })
        const record: Record<string, unknown> = {
            packId: oidc ? BundleBuilder.GenericOidcPackId : BundleBuilder.LocalPackId,
            delegationDepth: oidc ? DelegationDepth.AuthnDirectory : BundleBuilder.FullAuthzDepth,
            providerSettings: oidc ? BundleBuilder.OidcProviderSettings(oidc) : [],
            groupRoleMap: [],
            claimsMapping: [],
        }
        const modelPath = join(seedDir, BundleBuilder.SecurityModelFile)
        if (existsSync(modelPath))
        {
            record.securityModel = JSON.parse(readFileSync(modelPath, BundleBuilder.Utf8))
        }
        const configs: Record<string, unknown> = {}
        configs[def.environmentId] = record
        BundleBuilder.WriteJson(join(identityDir, BundleBuilder.TenantConfigFile), { configs })
    }

    private static OidcProviderSettings(oidc: EnvOidc): Array<[string, string]>
    {
        return [
            [OidcSettingKeys.Issuer, oidc.issuer],
            [OidcSettingKeys.DiscoveryUrl, oidc.discoveryUrl],
            [OidcSettingKeys.ClientId, oidc.clientId],
            [OidcSettingKeys.RedirectUri, oidc.redirectUri],
            [OidcSettingKeys.SecretRef, oidc.secretRef],
        ]
    }

    private static async WriteDemoApplication(tenantDir: string): Promise<void>
    {
        await NorthwindApp.Compile(join(tenantDir, BundleBuilder.PackagesDir))
        const appDir = join(tenantDir, BundleBuilder.ApplicationsDir, NorthwindApp.AppName)
        mkdirSync(appDir, { recursive: true })
        BundleBuilder.WriteJson(join(appDir, BundleBuilder.ApplicationFile), {
            name: NorthwindApp.AppName,
            version: NorthwindApp.Version,
            packages: [{ id: NorthwindApp.Id, version: NorthwindApp.Version }],
        })
    }

    private static RandomSecret(): string
    {
        return randomBytes(BundleBuilder.SecretBytes).toString(BundleBuilder.HexEncoding)
    }

    private static WriteJson(path: string, value: unknown): void
    {
        writeFileSync(path, JSON.stringify(value, null, BundleBuilder.Indent) + BundleBuilder.Newline)
    }
}
