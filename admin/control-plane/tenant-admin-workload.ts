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
    /** Secret holding the account-email fingerprint key under key `fingerprint.key`; mounted read-only at /fingerprint. */
    fingerprintKeySecretName?: string
    /** The console's own Postgres (a pragmatic-postgres sidecar in its pod); its passwords and URL arrive by Secret mount only. */
    database?: TenantAdminDatabaseSpec
}

/**
 * The console's Postgres: the pragmatic-postgres image run beside the console in its pod (reachable on the pod's loopback
 * only), its data on the console's volume, and the Secret holding the superuser password, the console's role password
 * and the console's database URL (keys TenantAdminDatabaseSecret.*).
 */
export interface TenantAdminDatabaseSpec
{
    image: string
    secretName: string
}

/** The keys of the console's database Secret and what its sidecar reconciles: the one home of their names. */
export class TenantAdminDatabaseSecret
{
    public static readonly SuperuserKey = 'superuser'
    public static readonly PasswordKey = 'password'
    public static readonly UrlKey = 'database-url'
    /** The application, database and role the pragmatic-postgres sidecar creates for the console. */
    public static readonly Application = 'pragmatic-tenant-admin'
    public static readonly Database = 'pragmatic_tenant_admin'
    public static readonly Role = 'pragmatic_tenant_admin'
    public static readonly Host = '127.0.0.1'
    public static readonly Port = 5432
    private static readonly UrlScheme = 'postgres://'
    private static readonly UserSeparator = ':'
    private static readonly HostSeparator = '@'
    private static readonly PathSeparator = '/'
    private static readonly Space = ' '

    /** The console's database URL for a role password (on the pod's loopback). */
    public static UrlOf(password: string): string
    {
        const S = TenantAdminDatabaseSecret
        return S.UrlScheme + S.Role + S.UserSeparator + encodeURIComponent(password) + S.HostSeparator + S.Host + S.UserSeparator + String(S.Port) + S.PathSeparator + S.Database
    }

    /** The sidecar's applications.conf line. */
    public static ApplicationsLine(): string
    {
        const S = TenantAdminDatabaseSecret
        return [S.Application, S.Database, S.Role].join(S.Space)
    }
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
