import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DevCa } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import type { IIdpSeedSource, IdpSeed } from './in-cluster-idp-driver.js'
import { IdpDatabaseSecret, K8sManifestBuilder } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

interface IdpSecretEntry
{
    name: string
    data: Map<string, Buffer>
}

/** The IdP's TLS + admin-token Secrets for one tenant. Bytes live in a #private field; the only exit is RenderManifest(). */
export class IdpSecretSet
{
    private static readonly ApiVersion = 'v1'
    private static readonly SecretKind = 'Secret'
    private static readonly ListKind = 'List'
    private static readonly OpaqueType = 'Opaque'
    private static readonly Base64 = 'base64'
    private static readonly ApiVersionKey = 'apiVersion'
    private static readonly KindKey = 'kind'
    private static readonly MetadataKey = 'metadata'
    private static readonly NameKey = 'name'
    private static readonly NamespaceKey = 'namespace'
    private static readonly TypeKey = 'type'
    private static readonly DataKey = 'data'
    private static readonly ItemsKey = 'items'
    private static readonly Redacted = '[IdpSecretSet: values redacted]'

    #entries: IdpSecretEntry[] = []

    public constructor(private readonly namespace: string)
    {
    }

    public Add(name: string, data: Map<string, Buffer>): void
    {
        // Defensive copy: later caller mutation must not change the secret set's bytes.
        const copy = new Map<string, Buffer>([...data].map(([k, v]) => [k, Buffer.from(v)]))
        this.#entries.push({ name, data: copy })
    }

    public Names(): string[]
    {
        return this.#entries.map(e => e.name)
    }

    /** A kubectl-appliable List of Secrets (base64 `data`) in the IdP namespace. */
    public RenderManifest(): string
    {
        const items = this.#entries.map(e => ({
            [IdpSecretSet.ApiVersionKey]: IdpSecretSet.ApiVersion,
            [IdpSecretSet.KindKey]: IdpSecretSet.SecretKind,
            [IdpSecretSet.MetadataKey]: { [IdpSecretSet.NameKey]: e.name, [IdpSecretSet.NamespaceKey]: this.namespace },
            [IdpSecretSet.TypeKey]: IdpSecretSet.OpaqueType,
            [IdpSecretSet.DataKey]: Object.fromEntries([...e.data].map(([k, v]) => [k, v.toString(IdpSecretSet.Base64)])),
        }))
        return JSON.stringify({ [IdpSecretSet.ApiVersionKey]: IdpSecretSet.ApiVersion, [IdpSecretSet.KindKey]: IdpSecretSet.ListKind, [IdpSecretSet.ItemsKey]: items })
    }

    public toJSON(): string
    {
        return IdpSecretSet.Redacted
    }

    public toString(): string
    {
        return IdpSecretSet.Redacted
    }
}

/** One tenant's generated material: the IdpSeed the driver consumes plus the Secrets to apply. Redacted when stringified. */
class IdpTenantSeed
{
    #seed: IdpSeed
    #secrets: IdpSecretSet
    #database: IdpSecretSet

    public constructor(seed: IdpSeed, secrets: IdpSecretSet, database: IdpSecretSet)
    {
        this.#seed = seed
        this.#secrets = secrets
        this.#database = database
    }

    /** The IdP's database Secret, kept apart from the TLS + admin seed: the driver applies it only when none exists. */
    public get Database(): IdpSecretSet
    {
        return this.#database
    }

    public get Seed(): IdpSeed
    {
        return this.#seed
    }

    public get Secrets(): IdpSecretSet
    {
        return this.#secrets
    }

    public toJSON(): string
    {
        return InClusterIdpSeedSource.Redacted
    }

    public toString(): string
    {
        return InClusterIdpSeedSource.Redacted
    }
}

/**
 * In-cluster IdP seed source: per tenant, generates the IdP's TLS (DevCa, SAN = the Service-DNS host the IdP self-issues on),
 * an admin token and the IdP's database passwords, once per process, and hands them out as the IdpSeed plus secret-safe Secret
 * manifests. In memory only: a new process mints anew, so the database Secret is applied only where none exists yet (the driver
 * checks), and its passwords never rotate across restarts.
 */
export class InClusterIdpSeedSource implements IIdpSeedSource
{
    public static readonly Redacted = '[InClusterIdpSeedSource: values redacted]'
    public static readonly TlsSecretSuffix = '-tls'
    public static readonly AdminSecretSuffix = '-admin'
    public static readonly AdminTokenKey = 'admin-token'
    private static readonly IdpPort = 9443
    private static readonly TokenBytes = 32
    private static readonly TokenEncoding = 'base64url'
    private static readonly TmpPrefix = 'idp-seed-'
    private static readonly Utf8 = 'utf8'
    private static readonly TlsFiles = ['server.crt', 'server.key', 'ca.crt']
    private static readonly CaFile = 'ca.crt'

    #tenants = new Map<string, IdpTenantSeed>()

    public constructor(private readonly openssl?: string, private readonly baseDomain?: string)
    {
    }

    /** The browser-facing base domain this source mints cert SANs for (the single authority; the driver reads it from here). */
    public get BaseDomain(): string | undefined
    {
        return this.baseDomain
    }

    public static TlsSecretNameOf(tenantId: string): string
    {
        return `${K8sManifestBuilder.IdpNameOf(tenantId)}${InClusterIdpSeedSource.TlsSecretSuffix}`
    }

    public static AdminSecretNameOf(tenantId: string): string
    {
        return `${K8sManifestBuilder.IdpNameOf(tenantId)}${InClusterIdpSeedSource.AdminSecretSuffix}`
    }

    /** The SAN hosts of the IdP cert: the internal Service-DNS host the IdP self-issues on (from IdpBaseUrlOf), plus the browser-facing idp-<tenant>.<baseDomain> when a baseDomain is set. */
    public static HostOf(tenantId: string, baseDomain?: string): readonly string[]
    {
        const internal = new URL(K8sManifestBuilder.IdpBaseUrlOf(tenantId, InClusterIdpSeedSource.IdpPort)).hostname
        return baseDomain === undefined ? [internal] : [internal, K8sManifestBuilder.IdpBrowserHostOf(tenantId, baseDomain)]
    }

    public SeedFor(tenantId: string): IdpSeed
    {
        return this.TenantSeed(tenantId).Seed
    }

    public SecretsFor(tenantId: string): IdpSecretSet
    {
        return this.TenantSeed(tenantId).Secrets
    }

    /** IIdpSeedSource hook: the IdP's database Secret (superuser, role password, URL), applied by the driver only where none exists. */
    public DatabaseSecretManifestFor(tenantId: string): string
    {
        return this.TenantSeed(tenantId).Database.RenderManifest()
    }

    /** IIdpSeedSource hook: the manifest of seed Secrets the driver applies before the workload. */
    public SecretsManifestFor(tenantId: string): string
    {
        return this.SecretsFor(tenantId).RenderManifest()
    }

    public toJSON(): string
    {
        return InClusterIdpSeedSource.Redacted
    }

    public toString(): string
    {
        return InClusterIdpSeedSource.Redacted
    }

    private TenantSeed(tenantId: string): IdpTenantSeed
    {
        let tenant = this.#tenants.get(tenantId)
        if (tenant === undefined)
        {
            tenant = this.Generate(tenantId)
            this.#tenants.set(tenantId, tenant)
        }
        return tenant
    }

    private Generate(tenantId: string): IdpTenantSeed
    {
        const dir = mkdtempSync(join(tmpdir(), InClusterIdpSeedSource.TmpPrefix))
        try
        {
            DevCa.EnsureAt(dir, InClusterIdpSeedSource.HostOf(tenantId, this.baseDomain), this.openssl)
            const tls = new Map<string, Buffer>()
            for (const file of InClusterIdpSeedSource.TlsFiles)
            {
                tls.set(file, readFileSync(join(dir, file)))
            }
            const token = randomBytes(InClusterIdpSeedSource.TokenBytes).toString(InClusterIdpSeedSource.TokenEncoding)
            const tlsName = InClusterIdpSeedSource.TlsSecretNameOf(tenantId)
            const adminName = InClusterIdpSeedSource.AdminSecretNameOf(tenantId)
            const secrets = new IdpSecretSet(K8sManifestBuilder.IdpNameOf(tenantId))
            secrets.Add(tlsName, tls)
            secrets.Add(adminName, new Map([[InClusterIdpSeedSource.AdminTokenKey, Buffer.from(token, InClusterIdpSeedSource.Utf8)]]))
            const seed: IdpSeed = {
                caRef: tlsName, adminTokenRef: InClusterIdpSeedSource.AdminTokenKey, tlsSecretName: tlsName, adminTokenSecretName: adminName,
                ca: tls.get(InClusterIdpSeedSource.CaFile)!, adminToken: token
            }
            const database = new IdpSecretSet(K8sManifestBuilder.IdpNameOf(tenantId))
            database.Add(IdpDatabaseSecret.NameOf(tenantId), IdpDatabaseSecret.Mint())
            return new IdpTenantSeed(seed, secrets, database)
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    }
}
