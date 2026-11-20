import { randomBytes } from 'node:crypto'
import type { IdpRecord } from './idp-record.js'
import type { IngressTls } from './ingress-tls.js'

/** The names every IdP workload shares, whichever driver launches it (a dev-box container or an in-cluster workload). */
export class IdpWorkloadNames
{
    /** Every per-tenant IdP workload's name starts with this, followed by the tenant id. */
    public static readonly NamePrefix = 'pragmatic-idp-'
}

export interface IdpConnection
{
    baseUrl: string
    /** The origin a browser reaches the IdP on; equals baseUrl when no separate browser-facing host exists. */
    browserBaseUrl: string
    ca: Buffer
    adminToken: string
    adminTokenRef: string
    caDir: string
    /** Base domain of the in-cluster browser hosts (idp-<tenant>.<baseDomain>, <env>.<baseDomain>); unset when none. */
    baseDomain?: string
}

export interface IdpWorkloadRequest
{
    tenantId: string
    displayName: string
    /** The persisted record for this tenant, when one exists (reuse / in-place recovery). */
    existing?: IdpRecord
    /** Ports already claimed by other tenants' IdPs (consumed by drivers that allocate host ports). */
    takenPorts: number[]
}

export interface IdpWorkloadResult
{
    connection: IdpConnection
    /** The record IdpService persists. The same reference as `existing` when nothing changed. */
    record: IdpRecord
}

/** The launch mechanism for one per-tenant IdP: a docker container (collapsed dev) or an in-cluster workload (the hive). Secrets travel by ref name; material never appears in errors. */
export interface IIdpWorkloadDriver
{
    EnsureRunning(request: IdpWorkloadRequest): Promise<IdpWorkloadResult>

    /** Rolls back a record this driver just CREATED (never a reused/recovered one) when persisting it failed. */
    Discard(record: IdpRecord): Promise<void>
}

/** What the in-cluster IdP workload is rendered from. Secrets are referenced by Secret object name only. */
export interface IdpWorkloadSpec
{
    tenantId: string
    hiveId: string
    image: string
    port: number
    /** Base domain for the browser-facing IdP host (idp-<tenant>.<baseDomain>); absent for single-host deployments. */
    baseDomain?: string
    /** Secret holding the admin token under key `adminTokenRef` (mounted at <data>/secrets). */
    adminTokenSecretName: string
    adminTokenRef: string
    /** Secret holding ca.crt / server.crt / server.key (mounted at <data>/tls). */
    tlsSecretName: string
    /** The Ingress TLS choice for the browser host; absent -> ssl-passthrough of the IdP's own certificate. */
    ingressTls?: IngressTls
    /**
     * The IdP's own Postgres (required: the realm sign-in service stores every record there and refuses to start without
     * it, so a spec without one would render a pod that can never become ready).
     */
    database: IdpDatabaseSpec
}

/**
 * The IdP's Postgres: the pragmatic-postgres image run beside the IdP in its pod (reachable on the pod's loopback only), its
 * data on its own volume, and the Secret (in the IdP namespace) holding the superuser password, the IdP's role password and
 * the IdP's database URL (keys IdpDatabaseSecret.*).
 */
export interface IdpDatabaseSpec
{
    image: string
    secretName: string
}

/** The keys of the IdP's database Secret and what its Postgres creates: the one home of their names. */
export class IdpDatabaseSecret
{
    public static readonly SuperuserKey = 'superuser'
    public static readonly PasswordKey = 'password'
    public static readonly UrlKey = 'database-url'
    /** The application (the realm sign-in service's component name), database and role its Postgres creates. */
    public static readonly Application = 'pragmatic-tenant-idp'
    public static readonly Database = 'tenant_idp'
    public static readonly Role = 'tenant_idp'
    public static readonly Host = '127.0.0.1'
    public static readonly Port = 5432
    /** The pragmatic-postgres image a development cluster runs (docker/postgres, loaded into kind). */
    public static readonly DevImage = 'pragmatic-postgres:local'
    private static readonly NameSuffix = '-postgres'
    private static readonly UrlScheme = 'postgres://'
    private static readonly UserSeparator = ':'
    private static readonly HostSeparator = '@'
    private static readonly PathSeparator = '/'
    private static readonly Space = ' '
    private static readonly PasswordBytes = 24
    private static readonly PasswordEncoding = 'base64url'
    private static readonly Utf8 = 'utf8'

    /** The IdP's pragmatic-postgres name (`pragmatic-idp-<tenant>-postgres`): its Secret, ConfigMap and volume claim. */
    public static NameOf(tenantId: string): string
    {
        return IdpWorkloadNames.NamePrefix + tenantId + IdpDatabaseSecret.NameSuffix
    }

    /** The IdP's database URL for a role password (on the loopback its Postgres shares with it). */
    public static UrlOf(password: string): string
    {
        const S = IdpDatabaseSecret
        return S.UrlScheme + S.Role + S.UserSeparator + encodeURIComponent(password) + S.HostSeparator + S.Host + S.UserSeparator + String(S.Port) + S.PathSeparator + S.Database
    }

    /** The pragmatic-postgres applications.conf line. */
    public static ApplicationsLine(): string
    {
        const S = IdpDatabaseSecret
        return [S.Application, S.Database, S.Role].join(S.Space)
    }

    /** A random database password (URL-safe, so the URL needs no escaping). */
    public static NewPassword(): string
    {
        return randomBytes(IdpDatabaseSecret.PasswordBytes).toString(IdpDatabaseSecret.PasswordEncoding)
    }

    /** Fresh Secret data: a superuser password, the IdP role's password and the URL that carries it. */
    public static Mint(): Map<string, Buffer>
    {
        const S = IdpDatabaseSecret
        const password = S.NewPassword()
        return new Map<string, Buffer>([
            [S.SuperuserKey, Buffer.from(S.NewPassword(), S.Utf8)],
            [S.PasswordKey, Buffer.from(password, S.Utf8)],
            [S.UrlKey, Buffer.from(S.UrlOf(password), S.Utf8)],
        ])
    }
}

/** Shared message plumbing for driver errors: only the message is forwarded, so secret material never reaches an error. */
export class IdpDriverMessages
{
    public static readonly Separator = ': '

    public static Detail(err: unknown): string
    {
        return err instanceof Error ? err.message : String(err)
    }
}
