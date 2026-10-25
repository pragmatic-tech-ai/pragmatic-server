import { randomBytes } from 'node:crypto'
import type { IdpWorkloadSpec } from './idp-workload-driver.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import type { HiveRecord, TenantRecord } from './platform-records.js'
import type { TenantAdminWorkloadSpec } from './tenant-admin-workload.js'
import type { TenantDirectorySeed } from './tenant-api/seeded-tenant-directory.js'

/** The slice of the platform deployment registry bootstrap needs: mint a hive's one-time agent bearer. */
export interface IHiveRegistrar
{
    RegisterHive(hiveId: string): Promise<string>
}

/** A pull-only registry credential supplied by the platform; the bytes are held in the secret set, never in the manifest. */
export interface PullCredential
{
    secretName: string
    dockerConfigJson: string
}

export interface TenantBootstrapInput
{
    tenant: TenantRecord
    hive: HiveRecord
    tenantAdminImage: string
    tenantPlanePort: number
    baseDomain: string
    externalScheme: string
    /** Pod-visible base URL of the platform agent channel (also the per-hive agent's registry URL). */
    channelUrl: string
    /** The tenant's IdP workload; the Secrets it names (TLS, admin token) are referenced, not minted here. Omit when the IdP is provisioned separately. */
    idp?: Pick<IdpWorkloadSpec, 'image' | 'port' | 'tlsSecretName' | 'adminTokenSecretName' | 'adminTokenRef'>
    /** The signing trust root's PUBLIC key (PEM). Never the private half. */
    trustRootPublicKey: string
    pullCredential?: PullCredential
}

type SecretEntry = { readonly name: string; readonly type: string; readonly data: Map<string, Buffer> }

/**
 * The secret material a bootstrap must carry to a hive. Values live only in ES private fields, so JSON.stringify,
 * String() and util.inspect of this object (or of anything holding it) show names, never bytes. The one way out is
 * RenderManifest(), meant to be piped straight to kubectl.
 */
export class BootstrapSecretSet
{
    private static readonly ApiVersion = 'v1'
    private static readonly SecretKind = 'Secret'
    private static readonly ListKind = 'List'
    private static readonly OpaqueType = 'Opaque'
    private static readonly Base64 = 'base64'
    private static readonly UnknownSecretPrefix = 'Unknown bootstrap secret: '
    private static readonly Redacted = '[BootstrapSecretSet: values redacted]'

    #entries: SecretEntry[] = []

    public Add(name: string, data: Record<string, Buffer | string>, type: string = BootstrapSecretSet.OpaqueType): void
    {
        const map = new Map<string, Buffer>()
        for (const [key, value] of Object.entries(data))
        {
            map.set(key, typeof value === 'string' ? Buffer.from(value, 'utf8') : value)
        }
        this.#entries.push({ name, type, data: map })
    }

    /** Adds a file to an already-added Secret (e.g. extra seeded state); throws when the Secret is unknown. */
    public AddEntry(secretName: string, key: string, value: Buffer | string): void
    {
        const entry = this.#entries.find(e => e.name === secretName)
        if (entry === undefined)
        {
            throw new Error(BootstrapSecretSet.UnknownSecretPrefix + secretName)
        }
        entry.data.set(key, typeof value === 'string' ? Buffer.from(value, 'utf8') : value)
    }

    public Names(): string[]
    {
        return this.#entries.map(e => e.name)
    }

    /** A kubectl-appliable List of Secrets (base64 `data`) in the shared system namespace. */
    public RenderManifest(): string
    {
        const items = this.#entries.map(e => ({
            apiVersion: BootstrapSecretSet.ApiVersion,
            kind: BootstrapSecretSet.SecretKind,
            metadata: { name: e.name, namespace: K8sManifestBuilder.SystemNamespace },
            type: e.type,
            data: Object.fromEntries([...e.data].map(([k, v]) => [k, v.toString(BootstrapSecretSet.Base64)])),
        }))
        return JSON.stringify({ apiVersion: BootstrapSecretSet.ApiVersion, kind: BootstrapSecretSet.ListKind, items })
    }

    public toJSON(): string
    {
        return BootstrapSecretSet.Redacted
    }

    public toString(): string
    {
        return BootstrapSecretSet.Redacted
    }
}

/** What a hive needs to stand up its tenant-admin: the seed read-models, the secret-free manifest set, and the secret set. */
export class TenantBootstrap
{
    public constructor(
        public readonly seed: TenantDirectorySeed,
        /** A v1 List (Namespace, agent, IdP, tenant-admin). Secrets are referenced by name only. */
        public readonly manifest: string,
        public readonly secrets: BootstrapSecretSet,
        public readonly agentTokenSecretName: string,
        public readonly seedSecretName: string)
    {
    }
}

/**
 * Platform-side provisioning split: mints the one-time agent token and a per-tenant master key, emits the tenant + hive
 * directory read-models as the tenant-admin seed, and assembles the bootstrap manifest set (agent + IdP + tenant-admin)
 * plus the Secrets they reference. Nothing secret is logged, returned in the manifest, or retained after the call.
 */
export class TenantAdminBootstrap
{
    public static readonly SeedKey = 'seed.json'
    public static readonly MasterKeyKey = 'master.key'
    public static readonly TrustRootKey = 'trust-root.pub'
    private static readonly TokenKey = 'token'
    private static readonly DockerConfigKey = '.dockerconfigjson'
    private static readonly DockerConfigType = 'kubernetes.io/dockerconfigjson'
    private static readonly MasterKeyBytes = 32
    private static readonly ApiVersion = 'v1'
    private static readonly ListKind = 'List'
    private static readonly NamespaceKind = 'Namespace'
    private static readonly JsonIndent = 2
    private static readonly KeySeparator = '/'

    public constructor(
        private readonly registrar: IHiveRegistrar,
        private readonly manifests: K8sManifestBuilder = new K8sManifestBuilder())
    {
    }

    public async GenerateBootstrap(input: TenantBootstrapInput): Promise<TenantBootstrap>
    {
        const { tenant, hive } = input
        const agentTokenSecretName = K8sManifestBuilder.AgentTokenSecretNameOf(hive.id)
        const seedSecretName = K8sManifestBuilder.TenantAdminSeedSecretNameOf(tenant.id)
        const agentToken = await this.registrar.RegisterHive(hive.id)
        const seed: TenantDirectorySeed = { tenant: { ...tenant }, hives: [{ ...hive, agentTokenRef: agentTokenSecretName }] }

        const secrets = new BootstrapSecretSet()
        secrets.Add(agentTokenSecretName, { [TenantAdminBootstrap.TokenKey]: agentToken })
        secrets.Add(seedSecretName, {
            [TenantAdminBootstrap.SeedKey]: JSON.stringify(seed, undefined, TenantAdminBootstrap.JsonIndent),
            [TenantAdminBootstrap.MasterKeyKey]: randomBytes(TenantAdminBootstrap.MasterKeyBytes),
            [TenantAdminBootstrap.TrustRootKey]: input.trustRootPublicKey,
        })
        if (input.pullCredential !== undefined)
        {
            secrets.Add(input.pullCredential.secretName, { [TenantAdminBootstrap.DockerConfigKey]: input.pullCredential.dockerConfigJson }, TenantAdminBootstrap.DockerConfigType)
        }
        return new TenantBootstrap(seed, this.AssembleManifest(input, agentTokenSecretName, seedSecretName), secrets, agentTokenSecretName, seedSecretName)
    }

    private AssembleManifest(input: TenantBootstrapInput, agentTokenSecretName: string, seedSecretName: string): string
    {
        const { tenant, hive } = input
        const admin: TenantAdminWorkloadSpec = {
            tenantId: tenant.id,
            hiveId: hive.id,
            image: input.tenantAdminImage,
            port: input.tenantPlanePort,
            baseDomain: input.baseDomain,
            externalScheme: input.externalScheme,
            seedSecretName,
            agentTokenSecretName,
            rolloutUrl: input.channelUrl,
            imagePullSecretName: input.pullCredential?.secretName,
        }
        const rendered = [this.manifests.RenderHiveAgent(hive.id, input.channelUrl, agentTokenSecretName)]
        if (input.idp !== undefined)
        {
            const idp: IdpWorkloadSpec = { tenantId: tenant.id, hiveId: hive.id, ...input.idp }
            rendered.push(this.manifests.RenderIdp(idp))
        }
        rendered.push(this.manifests.RenderTenantAdmin(admin))
        const items = rendered.flatMap(r => (JSON.parse(r) as { items: Array<{ kind: string; metadata: { name: string } }> }).items)
        const seen = new Set<string>()
        const unique = items.filter(i =>
        {
            const key = i.kind + TenantAdminBootstrap.KeySeparator + i.metadata.name
            if (seen.has(key))
            {
                return false
            }
            seen.add(key)
            return true
        })
        // Namespaces first so every namespaced object applies in one pass.
        const ordered = [
            ...unique.filter(i => i.kind === TenantAdminBootstrap.NamespaceKind),
            ...unique.filter(i => i.kind !== TenantAdminBootstrap.NamespaceKind),
        ]
        return JSON.stringify({ apiVersion: TenantAdminBootstrap.ApiVersion, kind: TenantAdminBootstrap.ListKind, items: ordered })
    }
}
