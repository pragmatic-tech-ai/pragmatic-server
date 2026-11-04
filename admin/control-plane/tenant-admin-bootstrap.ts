import { randomBytes } from 'node:crypto'
import { ConsoleFingerprintKeys } from './console-fingerprint-keys.js'
import type { IdpWorkloadSpec } from './idp-workload-driver.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import type { VerifiedImage } from './pinned-image-verifier.js'
import type { HiveRecord, TenantRecord } from './platform-records.js'
import type { TenantAdminWorkloadSpec, TenantConsoleExposure } from './tenant-admin-workload.js'
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
    /** The tenant's organisation name, seeded into the hive read-model when known. */
    organisation?: string
    tenantAdminImage: string
    tenantPlanePort: number
    baseDomain: string
    externalScheme: string
    /** Pod-visible base URL of the platform agent channel (also the per-hive agent's registry URL). */
    channelUrl: string
    /**
     * The tenant's IdP workload. RenderIdp puts it in its OWN namespace (K8sManifestBuilder.IdpNameOf(tenant.id)) and mounts the
     * Secrets it names (TLS, admin token) from THERE. Bootstrap only references them: it never mints or emits them (the bootstrap
     * Secret set is pragmatic-system only), so whoever provisions the IdP must create them in the IdP namespace. Omit when the IdP
     * is provisioned separately.
     */
    idp?: Pick<IdpWorkloadSpec, 'image' | 'port' | 'tlsSecretName' | 'adminTokenSecretName' | 'adminTokenRef' | 'ingressTls'> & TenantIdpMaterial
    /** The signing trust root's PUBLIC key (PEM). Never the private half. */
    trustRootPublicKey: string
    pullCredential?: PullCredential
    /**
     * True when the hive agent already runs (the in-hive console install): no RegisterHive, no agent-token Secret and no hive
     * agent objects in the set (re-applying them would revert the running agent). The console still references
     * AgentTokenSecretNameOf(hive.id), the agent's own Secret.
     */
    reuseAgentToken?: boolean
    /** Browser exposure of the console (host + Ingress TLS choice); the console also places its environments with this TLS choice. */
    console?: TenantConsoleExposure
    /** The 32-byte session-fingerprint key; carried in its own hive-labelled Secret and mounted by the console. */
    fingerprintKey?: Buffer
    /** The platform-pinned image refs the console may run; written into the seed Secret as verified-images.json. */
    verifiedImages?: readonly VerifiedImage[]
    /** The console's existing 32-byte master key (reinstall keeps the data PVC readable); a fresh one is minted when omitted. */
    masterKey?: Buffer
}

/**
 * The minted IdP material the producer projects for the tenant-admin pod (which lives in pragmatic-system, so it cannot mount the
 * IdP-namespace Secrets). `ca` is the PUBLIC CA certificate only; the IdP's TLS Secret (server key) is never referenced by the pod.
 * When both are supplied the tenant-admin spec gets its `idp` connection and the Secrets below are projected.
 */
export interface TenantIdpMaterial
{
    ca?: Buffer
    adminToken?: string
}

/** A rendered v1 List as the builder emits it (only the fields bootstrap reads). */
type RenderedList = { items: RenderedItem[] }
type RenderedItem = { kind: string; metadata: { name: string } }

type SecretEntry = { readonly name: string; readonly type: string; readonly data: Map<string, Buffer>; readonly retention: SecretRetention }

/** What a hive delete does with a bootstrap Secret. */
export enum SecretRetention
{
    /** Hive-labelled: removed with the hive's other objects. */
    RemovedWithHive,
    /** Unlabelled: kept on hive delete (the seed, whose master key decrypts the retained data PVC). */
    Retained,
}

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
    private static readonly Utf8 = 'utf8'
    private static readonly ApiVersionKey = 'apiVersion'
    private static readonly KindKey = 'kind'
    private static readonly MetadataKey = 'metadata'
    private static readonly NameKey = 'name'
    private static readonly NamespaceKey = 'namespace'
    private static readonly LabelsKey = 'labels'
    private static readonly TypeKey = 'type'
    private static readonly DataKey = 'data'
    private static readonly ItemsKey = 'items'
    private static readonly UnknownSecretPrefix = 'Unknown bootstrap secret: '
    private static readonly Redacted = '[BootstrapSecretSet: values redacted]'

    #entries: SecretEntry[] = []

    /** With a hive id, every Secret not marked Retained carries the hive's label, so a hive delete finds it by selector. */
    public constructor(private readonly hiveId?: string)
    {
    }

    public Add(name: string, data: Record<string, Buffer | string>, type: string = BootstrapSecretSet.OpaqueType, retention: SecretRetention = SecretRetention.RemovedWithHive): void
    {
        const map = new Map<string, Buffer>()
        for (const [key, value] of Object.entries(data))
        {
            map.set(key, typeof value === 'string' ? Buffer.from(value, BootstrapSecretSet.Utf8) : value)
        }
        this.#entries.push({ name, type, data: map, retention })
    }

    /** Adds a file to an already-added Secret (e.g. extra seeded state); throws when the Secret is unknown. */
    public AddEntry(secretName: string, key: string, value: Buffer | string): void
    {
        const entry = this.#entries.find(e => e.name === secretName)
        if (entry === undefined)
        {
            throw new Error(BootstrapSecretSet.UnknownSecretPrefix + secretName)
        }
        entry.data.set(key, typeof value === 'string' ? Buffer.from(value, BootstrapSecretSet.Utf8) : value)
    }

    public Names(): string[]
    {
        return this.#entries.map(e => e.name)
    }

    /** A kubectl-appliable List of Secrets (base64 `data`) in the shared system namespace. */
    public RenderManifest(): string
    {
        const items = this.#entries.map(e => ({
            [BootstrapSecretSet.ApiVersionKey]: BootstrapSecretSet.ApiVersion,
            [BootstrapSecretSet.KindKey]: BootstrapSecretSet.SecretKind,
            [BootstrapSecretSet.MetadataKey]: this.Metadata(e),
            [BootstrapSecretSet.TypeKey]: e.type,
            [BootstrapSecretSet.DataKey]: Object.fromEntries([...e.data].map(([k, v]) => [k, v.toString(BootstrapSecretSet.Base64)])),
        }))
        return JSON.stringify({ [BootstrapSecretSet.ApiVersionKey]: BootstrapSecretSet.ApiVersion, [BootstrapSecretSet.KindKey]: BootstrapSecretSet.ListKind, [BootstrapSecretSet.ItemsKey]: items })
    }

    private Metadata(e: SecretEntry): Record<string, unknown>
    {
        const meta: Record<string, unknown> = { [BootstrapSecretSet.NameKey]: e.name, [BootstrapSecretSet.NamespaceKey]: K8sManifestBuilder.SystemNamespace }
        if (this.hiveId !== undefined && e.retention === SecretRetention.RemovedWithHive)
        {
            meta[BootstrapSecretSet.LabelsKey] = K8sManifestBuilder.HiveLabelsOf(this.hiveId)
        }
        return meta
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
        /** A v1 List (Namespace, agent unless the token is reused, IdP, tenant-admin). Secrets are referenced by name only. */
        public readonly manifest: string,
        public readonly secrets: BootstrapSecretSet,
        public readonly agentTokenSecretName: string,
        public readonly seedSecretName: string)
    {
    }
}

/**
 * The production renderer of a tenant's console (used by TenantConsoleInstaller for the in-hive install, and by the bootstrap
 * smokes): mints (or, for a running hive agent, reuses) the agent token and a per-tenant master key (or keeps the existing one
 * on reinstall), emits the tenant + hive directory read-models as the tenant-admin seed (with the pinned-image allow-list),
 * and assembles the manifest set (agent unless reused + IdP + tenant-admin with its console exposure) plus the Secrets they
 * reference (seed, fingerprint key, IdP CA / admin-token copies, pull credential). Nothing secret is logged, returned in the
 * manifest, or retained after the call.
 */
export class TenantAdminBootstrap
{
    public static readonly SeedKey = 'seed.json'
    public static readonly MasterKeyKey = 'master.key'
    public static readonly TrustRootKey = 'trust-root.pub'
    /** The platform-pinned image refs the console may run (PinnedImageVerifier's file). */
    public static readonly VerifiedImagesKey = 'verified-images.json'
    /** The one key of the fingerprint Secret (mounted by the console at /fingerprint/fingerprint.key). */
    public static readonly FingerprintKeyKey = K8sManifestBuilder.FingerprintItemKey
    private static readonly TokenKey = 'token'
    private static readonly IdpCaKey = 'ca.crt'
    private static readonly IdpAdminTokenKey = 'admin-token'
    private static readonly PartialIdpMaterial = 'TenantAdminBootstrap: idp.ca and idp.adminToken must be supplied together (or neither)'
    private static readonly DockerConfigKey = '.dockerconfigjson'
    private static readonly DockerConfigType = 'kubernetes.io/dockerconfigjson'
    private static readonly MasterKeyBytes = 32
    private static readonly BadMasterKey = 'TenantAdminBootstrap: the console master key must be exactly 32 bytes'
    private static readonly BadFingerprintKey = 'TenantAdminBootstrap: the console fingerprint key must be exactly 32 bytes'
    private static readonly ApiVersionKey = 'apiVersion'
    private static readonly KindKey = 'kind'
    private static readonly ItemsKey = 'items'
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

    /** Name of the ca.crt-only IdP trust Secret projected into pragmatic-system for the tenant-admin pod. */
    public static IdpCaSecretNameOf(tenantId: string): string
    {
        return K8sManifestBuilder.TenantConsoleIdpCaSecretNameOf(tenantId)
    }

    /** Name of the admin-token Secret copy projected into pragmatic-system (the IdP-namespace original is unreachable from the pod). */
    public static IdpTokenSecretNameOf(tenantId: string): string
    {
        return K8sManifestBuilder.TenantConsoleIdpTokenSecretNameOf(tenantId)
    }

    /** Name of the console's session-fingerprint key Secret in pragmatic-system (pragmatic-tenant-admin-<tenant>-fingerprint). */
    public static FingerprintKeySecretNameOf(tenantId: string): string
    {
        return K8sManifestBuilder.TenantConsoleFingerprintSecretNameOf(tenantId)
    }

    /**
     * The tenant-admin's live-credential Secret copies in pragmatic-system, as a v1 List of identities to delete by name on hive
     * delete (older clusters have them unlabelled): the fingerprint key, the IdP CA and the IdP admin-token copy - the same list
     * TenantConsoleRemovalManifest names. Never the seed Secret.
     */
    public static CredentialRemovalManifest(tenantId: string): string
    {
        const C = TenantAdminBootstrap
        return JSON.stringify({
            [C.ApiVersionKey]: C.ApiVersion,
            [C.KindKey]: C.ListKind,
            [C.ItemsKey]: K8sManifestBuilder.TenantConsoleCredentialIdentitiesOf(tenantId),
        })
    }

    public async GenerateBootstrap(input: TenantBootstrapInput): Promise<TenantBootstrap>
    {
        const { tenant, hive } = input
        TenantAdminBootstrap.AssertKeyLength(input.masterKey, TenantAdminBootstrap.MasterKeyBytes, TenantAdminBootstrap.BadMasterKey)
        TenantAdminBootstrap.AssertKeyLength(input.fingerprintKey, ConsoleFingerprintKeys.KeyBytes, TenantAdminBootstrap.BadFingerprintKey)
        const agentTokenSecretName = K8sManifestBuilder.AgentTokenSecretNameOf(hive.id)
        const seedSecretName = K8sManifestBuilder.TenantAdminSeedSecretNameOf(tenant.id)
        const seed: TenantDirectorySeed = { tenant: { ...tenant }, hives: [{ ...hive, agentTokenRef: agentTokenSecretName }], ...(input.organisation !== undefined ? { organisation: input.organisation } : {}) }

        const secrets = new BootstrapSecretSet(hive.id)
        if (input.reuseAgentToken !== true)
        {
            secrets.Add(agentTokenSecretName, { [TenantAdminBootstrap.TokenKey]: await this.registrar.RegisterHive(hive.id) })
        }
        // Retained on hive delete together with the data PVC: its master key is what decrypts that data.
        secrets.Add(seedSecretName, {
            [TenantAdminBootstrap.SeedKey]: JSON.stringify(seed, undefined, TenantAdminBootstrap.JsonIndent),
            [TenantAdminBootstrap.MasterKeyKey]: input.masterKey ?? randomBytes(TenantAdminBootstrap.MasterKeyBytes),
            [TenantAdminBootstrap.TrustRootKey]: input.trustRootPublicKey,
        }, undefined, SecretRetention.Retained)
        if (input.verifiedImages !== undefined)
        {
            // The init container copies the seed Secret into the data root, where PinnedImageVerifier reads it.
            const images: VerifiedImage[] = input.verifiedImages.map(i => ({ imageRef: i.imageRef }))
            secrets.AddEntry(seedSecretName, TenantAdminBootstrap.VerifiedImagesKey, JSON.stringify(images, undefined, TenantAdminBootstrap.JsonIndent))
        }
        if (input.fingerprintKey !== undefined)
        {
            secrets.Add(TenantAdminBootstrap.FingerprintKeySecretNameOf(tenant.id), { [TenantAdminBootstrap.FingerprintKeyKey]: input.fingerprintKey })
        }
        if (input.pullCredential !== undefined)
        {
            secrets.Add(input.pullCredential.secretName, { [TenantAdminBootstrap.DockerConfigKey]: input.pullCredential.dockerConfigJson }, TenantAdminBootstrap.DockerConfigType)
        }
        const material = TenantAdminBootstrap.IdpMaterial(input)
        if (material !== undefined)
        {
            // ca.crt ONLY: derived from the CA bytes alone, never the IdP TLS Secret (server.key).
            secrets.Add(TenantAdminBootstrap.IdpCaSecretNameOf(tenant.id), { [TenantAdminBootstrap.IdpCaKey]: material.ca })
            secrets.Add(TenantAdminBootstrap.IdpTokenSecretNameOf(tenant.id), { [TenantAdminBootstrap.IdpAdminTokenKey]: material.adminToken })
        }
        return new TenantBootstrap(seed, this.AssembleManifest(input, agentTokenSecretName, seedSecretName, material !== undefined), secrets, agentTokenSecretName, seedSecretName)
    }

    private static AssertKeyLength(key: Buffer | undefined, bytes: number, message: string): void
    {
        if (key !== undefined && key.length !== bytes)
        {
            throw new Error(message)
        }
    }

    /**
     * The projected IdP material, or undefined when the IdP is provisioned separately. ALL-OR-NOTHING: supplying
     * exactly one of `ca`/`adminToken` is a misconfiguration (it would silently leave the pod unfederated), so it throws.
     */
    private static IdpMaterial(input: TenantBootstrapInput): { ca: Buffer; adminToken: string } | undefined
    {
        const ca = input.idp?.ca
        const adminToken = input.idp?.adminToken
        if ((ca === undefined) !== (adminToken === undefined))
        {
            throw new Error(TenantAdminBootstrap.PartialIdpMaterial)
        }
        return ca !== undefined && adminToken !== undefined ? { ca, adminToken } : undefined
    }

    private AssembleManifest(input: TenantBootstrapInput, agentTokenSecretName: string, seedSecretName: string, federated: boolean): string
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
            console: input.console,
            fingerprintKeySecretName: input.fingerprintKey === undefined ? undefined : TenantAdminBootstrap.FingerprintKeySecretNameOf(tenant.id),
        }
        // federated implies input.idp is defined (IdpMaterial requires it); the `&& input.idp` narrows it for TS.
        if (federated && input.idp !== undefined)
        {
            admin.idp = {
                browserBaseUrl: K8sManifestBuilder.IdpBrowserUrlOf(tenant.id, input.baseDomain),
                internalBaseUrl: K8sManifestBuilder.IdpBaseUrlOf(tenant.id, input.idp.port),
                caSecretName: TenantAdminBootstrap.IdpCaSecretNameOf(tenant.id),
                adminTokenSecretName: TenantAdminBootstrap.IdpTokenSecretNameOf(tenant.id),
            }
        }
        // A reused token means the hive agent already runs: re-applying it would revert its Deployment and RBAC.
        const rendered = input.reuseAgentToken === true ? [] : [this.manifests.RenderHiveAgent(hive.id, input.channelUrl, agentTokenSecretName)]
        if (input.idp !== undefined)
        {
            const { image, port, tlsSecretName, adminTokenSecretName, adminTokenRef, ingressTls } = input.idp
            const idp: IdpWorkloadSpec = { tenantId: tenant.id, hiveId: hive.id, image, port, tlsSecretName, adminTokenSecretName, adminTokenRef, ingressTls }
            if (admin.idp !== undefined)
            {
                idp.baseDomain = input.baseDomain
            }
            rendered.push(this.manifests.RenderIdp(idp))
        }
        rendered.push(this.manifests.RenderTenantAdmin(admin))
        const items = rendered.flatMap(r => (JSON.parse(r) as RenderedList).items)
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
        return JSON.stringify({ [TenantAdminBootstrap.ApiVersionKey]: TenantAdminBootstrap.ApiVersion, [TenantAdminBootstrap.KindKey]: TenantAdminBootstrap.ListKind, [TenantAdminBootstrap.ItemsKey]: ordered })
    }
}
