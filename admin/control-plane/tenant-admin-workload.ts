import type { IngressTls } from './ingress-tls.js'

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
    /** Operator-provisioned IdP the pod connects to; CA cert and admin token arrive by Secret mount only. */
    idp?: TenantAdminIdpInjection
    /** Browser exposure of the console; the Ingress (and, for a copied TLS Secret, its get-only read Role) is rendered only when set. */
    console?: TenantConsoleExposure
    /** Secret holding the session-fingerprint key under key `fingerprint.key`; mounted read-only at /fingerprint. */
    fingerprintKeySecretName?: string
}

/** The console's browser host and the Ingress TLS choice it is served with. */
export interface TenantConsoleExposure
{
    host: string
    ingressTls: IngressTls
    /** The ingress controller's namespace, the only one the console's NetworkPolicy admits; absent means ingress-nginx. */
    ingressNamespace?: string
}

export interface TenantAdminIdpInjection
{
    browserBaseUrl: string
    internalBaseUrl: string
    /** Secret holding ONLY the public CA certificate under key `ca.crt` (never the TLS Secret with the server key). */
    caSecretName: string
    /** Secret holding the IdP admin token under key `admin-token`. */
    adminTokenSecretName: string
}
