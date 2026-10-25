/** What the tenant-admin container is rendered from. Secrets are referenced by Secret object name only. */
export interface TenantAdminWorkloadSpec
{
    tenantId: string
    hiveId: string
    image: string
    /** The tenant plane listener port (container + Service). */
    port: number
    baseDomain: string
    externalScheme: string
    /** Secret holding seed.json + master.key (+ the trust-root public key); copied into the data root by the init container. */
    seedSecretName: string
    /** Secret holding the per-hive agent bearer under key `token` (the same one the hive agent uses). */
    agentTokenSecretName: string
    /** Pod-visible base URL of the platform agent channel. */
    rolloutUrl: string
    /** Optional pull-only registry credential Secret (dockerconfigjson) for the image. */
    imagePullSecretName?: string
}
