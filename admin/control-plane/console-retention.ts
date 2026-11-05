import { InClusterIdpSeedSource } from './in-cluster-idp-seed.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import type { IKubectl } from './kubectl.js'

/**
 * What a console removal (or a hive delete) deliberately keeps of a tenant's console and its in-hive IdP: the console's data PVC and
 * the seed Secret whose master key decrypts it, and the IdP's data PVC, TLS Secret (its CA) and admin-token Secret. A reinstall
 * resumes from them; the operator is told their names.
 */
export class ConsoleRetention
{
    private static readonly ClaimPrefix = 'persistentvolumeclaim/'
    private static readonly SecretPrefix = 'secret/'

    /** The kept objects that actually exist, by name, in a fixed order (console first, then the IdP). */
    public static async ExistingOf(kubectl: IKubectl, tenantId: string): Promise<string[]>
    {
        const kept: string[] = []
        for (const [namespace, resource, name] of ConsoleRetention.CandidatesOf(tenantId))
        {
            if (await kubectl.Find(namespace, resource + name) !== undefined)
            {
                kept.push(name)
            }
        }
        return kept
    }

    private static CandidatesOf(tenantId: string): Array<[string, string, string]>
    {
        const C = ConsoleRetention
        const system = K8sManifestBuilder.SystemNamespace
        const idp = K8sManifestBuilder.IdpNameOf(tenantId)
        return [
            [system, C.ClaimPrefix, K8sManifestBuilder.TenantAdminClaimNameOf(tenantId)],
            [system, C.SecretPrefix, K8sManifestBuilder.TenantAdminSeedSecretNameOf(tenantId)],
            [idp, C.ClaimPrefix, K8sManifestBuilder.IdpClaimNameOf(tenantId)],
            [idp, C.SecretPrefix, InClusterIdpSeedSource.TlsSecretNameOf(tenantId)],
            [idp, C.SecretPrefix, InClusterIdpSeedSource.AdminSecretNameOf(tenantId)],
        ]
    }
}
