import type { IdpRecord } from './idp-record.js'

export interface IdpConnection
{
    baseUrl: string
    /** The origin a browser reaches the IdP on; equals baseUrl when no separate browser-facing host exists. */
    browserBaseUrl: string
    ca: Buffer
    adminToken: string
    adminTokenRef: string
    caDir: string
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
