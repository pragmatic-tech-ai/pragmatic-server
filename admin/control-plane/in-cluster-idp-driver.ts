import { IdpStatus } from './idp-record.js'
import type { IdpRecord } from './idp-record.js'
import type { IIdpWorkloadDriver, IdpWorkloadRequest, IdpWorkloadResult, IdpWorkloadSpec } from './idp-workload-driver.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import type { IKubectl } from './kubectl.js'

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
}

/** Hive driver: renders the IdP as an in-cluster workload, applies it through the in-cluster API (kubectl seam), and reports the Service-DNS baseUrl. CA / admin token are SEEDED from bootstrap, never minted here. */
export class InClusterIdpDriver implements IIdpWorkloadDriver
{
    private static readonly IdpPort = 9443
    private static readonly ApplyFailed = 'In-cluster IdP apply failed for tenant '
    private static readonly Sep = ': '

    public constructor(
        private readonly kubectl: IKubectl,
        private readonly manifests: K8sManifestBuilder,
        private readonly seeds: IIdpSeedSource,
        private readonly hiveId: string,
        private readonly image: string)
    {
    }

    public async EnsureRunning(request: IdpWorkloadRequest): Promise<IdpWorkloadResult>
    {
        const { tenantId } = request
        const seed = this.seeds.SeedFor(tenantId)
        const spec: IdpWorkloadSpec = {
            tenantId, hiveId: this.hiveId, image: this.image, port: InClusterIdpDriver.IdpPort,
            adminTokenSecretName: seed.adminTokenSecretName, adminTokenRef: seed.adminTokenRef, tlsSecretName: seed.tlsSecretName
        }
        const name = K8sManifestBuilder.IdpNameOf(tenantId)
        try
        {
            await this.kubectl.Apply(this.manifests.RenderIdp(spec))
            await this.kubectl.RolloutStatus(name, name)
        }
        catch (err)
        {
            // Message only (KubectlError already redacts); the seeded token / CA are never part of it.
            const detail = err instanceof Error ? err.message : String(err)
            throw new Error(`${InClusterIdpDriver.ApplyFailed}${tenantId}${InClusterIdpDriver.Sep}${detail}`)
        }
        const baseUrl = K8sManifestBuilder.IdpBaseUrlOf(tenantId, InClusterIdpDriver.IdpPort)
        const record: IdpRecord = request.existing ?? {
            tenantId, port: InClusterIdpDriver.IdpPort, baseUrl, containerName: name, volumeName: K8sManifestBuilder.IdpClaimNameOf(tenantId),
            caDir: seed.caRef, adminTokenRef: seed.adminTokenRef, createdAt: new Date().toISOString(), status: IdpStatus.Running
        }
        return { connection: { baseUrl, ca: seed.ca, adminToken: seed.adminToken, adminTokenRef: seed.adminTokenRef, caDir: seed.caRef }, record }
    }
}
