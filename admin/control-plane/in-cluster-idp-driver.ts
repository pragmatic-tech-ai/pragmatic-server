import { IdpStatus, type IdpRecord } from './idp-record.js'
import { IdpDatabaseSecret, IdpDriverMessages, type IIdpWorkloadDriver, type IdpWorkloadRequest, type IdpWorkloadResult, type IdpWorkloadSpec } from './idp-workload-driver.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import type { IKubectl } from '@pragmatic-tech-ai/pragmatic-kube'

/** Bootstrap-seeded identity material for one tenant's IdP. The refs name Secret objects / keys; the bytes are only handed back in-process to IdpService consumers. */
export interface IdpSeed
{
    /** Reference to the CA material (the TLS Secret name); surfaces as IdpConnection.caDir. */
    caRef: string
    adminTokenRef: string
    tlsSecretName: string
    adminTokenSecretName: string
    ca: Buffer
    adminToken: string
}

export interface IIdpSeedSource
{
    SeedFor(tenantId: string): IdpSeed
    /** Optional: a kubectl-appliable manifest of the seed Secrets, applied before the workload so the mounted Secrets exist. */
    SecretsManifestFor?(tenantId: string): string
    /**
     * Optional: a kubectl-appliable manifest of the IdP's database Secret (IdpDatabaseSecret.NameOf, keys IdpDatabaseSecret.*). The
     * driver applies it only while the IdP namespace holds no such Secret: its passwords open the IdP's stored data, so an
     * existing one is never replaced (a seed source minting afresh after a restart cannot rotate it).
     */
    DatabaseSecretManifestFor?(tenantId: string): string
    /** The browser-facing base domain, owned by the seed source (which mints the cert SANs). The driver reads it from here so the advertised browser host and the cert SANs can never diverge. */
    readonly BaseDomain?: string
}

/**
 * Hive driver: renders the IdP (with its Postgres sidecar) as an in-cluster workload, applies it through the in-cluster API (kubectl
 * seam), and reports the Service-DNS baseUrl. CA / admin token / database passwords are SEEDED by the seed source, never minted here.
 */
export class InClusterIdpDriver implements IIdpWorkloadDriver
{
    private static readonly IdpPort = 9443
    private static readonly ApplyFailed = 'In-cluster IdP apply failed for tenant '
    private static readonly SecretPrefix = 'secret/'

    public constructor(
        private readonly kubectl: IKubectl,
        private readonly manifests: K8sManifestBuilder,
        private readonly seeds: IIdpSeedSource,
        private readonly hiveId: string,
        private readonly image: string,
        /** The pragmatic-postgres image of the IdP's database sidecar (a release's, or the development image loaded into kind). */
        private readonly postgresImage: string = IdpDatabaseSecret.DevImage)
    {
    }

    public async EnsureRunning(request: IdpWorkloadRequest): Promise<IdpWorkloadResult>
    {
        const { tenantId } = request
        const seed = this.seeds.SeedFor(tenantId)
        const spec: IdpWorkloadSpec = {
            tenantId, hiveId: this.hiveId, image: this.image, port: InClusterIdpDriver.IdpPort, baseDomain: this.seeds.BaseDomain,
            adminTokenSecretName: seed.adminTokenSecretName, adminTokenRef: seed.adminTokenRef, tlsSecretName: seed.tlsSecretName,
            database: { image: this.postgresImage, secretName: IdpDatabaseSecret.NameOf(tenantId) }
        }
        const name = K8sManifestBuilder.IdpNameOf(tenantId)
        try
        {
            await this.kubectl.Apply(this.manifests.RenderIdp(spec))
            // Seed Secrets go in after the workload apply (which creates the namespace) and before rollout, so the pod's Secret mounts resolve.
            const secrets = this.seeds.SecretsManifestFor?.(tenantId)
            if (secrets !== undefined)
            {
                await this.kubectl.Apply(secrets)
            }
            await this.EnsureDatabaseSecret(tenantId, name)
            await this.kubectl.RolloutStatus(name, name)
        }
        catch (err)
        {
            // Message only (KubectlError already redacts); the seeded token / CA are never part of it.
            const detail = IdpDriverMessages.Detail(err)
            throw new Error(`${InClusterIdpDriver.ApplyFailed}${tenantId}${IdpDriverMessages.Separator}${detail}`)
        }
        const baseUrl = K8sManifestBuilder.IdpBaseUrlOf(tenantId, InClusterIdpDriver.IdpPort)
        const record = this.RecordFor(request.existing, tenantId, baseUrl, name, seed)
        const browserBaseUrl = this.seeds.BaseDomain === undefined ? baseUrl : K8sManifestBuilder.IdpBrowserUrlOf(tenantId, this.seeds.BaseDomain)
        return { connection: { baseUrl, browserBaseUrl, ca: seed.ca, adminToken: seed.adminToken, adminTokenRef: seed.adminTokenRef, caDir: seed.caRef, baseDomain: this.seeds.BaseDomain }, record }
    }

    /** Applies the seed source's database Secret (server-side: no last-applied copy of its values) unless the IdP namespace already holds one. */
    private async EnsureDatabaseSecret(tenantId: string, namespace: string): Promise<void>
    {
        if (this.seeds.DatabaseSecretManifestFor === undefined)
        {
            return
        }
        if (await this.kubectl.Find(namespace, InClusterIdpDriver.SecretPrefix + IdpDatabaseSecret.NameOf(tenantId)) !== undefined)
        {
            return
        }
        await this.kubectl.ApplyServerSide(this.seeds.DatabaseSecretManifestFor(tenantId))
    }

    /** In-cluster Discard is a no-op: apply is idempotent and the workload is reconciled on the next call. */
    public async Discard(): Promise<void>
    {
    }

    /** Rebuilds the record for the in-cluster connection; a matching existing record is returned as-is (no re-persist), a stale one (e.g. a docker baseUrl) is replaced. */
    private RecordFor(existing: IdpRecord | undefined, tenantId: string, baseUrl: string, name: string, seed: IdpSeed): IdpRecord
    {
        const fresh: IdpRecord = {
            tenantId, port: InClusterIdpDriver.IdpPort, baseUrl, containerName: name, volumeName: K8sManifestBuilder.IdpClaimNameOf(tenantId),
            caDir: seed.caRef, adminTokenRef: seed.adminTokenRef, createdAt: existing?.createdAt ?? new Date().toISOString(), status: IdpStatus.Running
        }
        const same = existing !== undefined && existing.port === fresh.port && existing.baseUrl === fresh.baseUrl && existing.containerName === fresh.containerName
            && existing.volumeName === fresh.volumeName && existing.caDir === fresh.caDir && existing.adminTokenRef === fresh.adminTokenRef && existing.status === fresh.status
        return same ? existing : fresh
    }
}
