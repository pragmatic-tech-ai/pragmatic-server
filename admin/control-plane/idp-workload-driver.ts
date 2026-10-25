import type { IdpRecord } from './idp-record.js'

export interface IdpConnection
{
    baseUrl: string
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
}

/** What the in-cluster IdP workload is rendered from. Secrets are referenced by Secret object name only. */
export interface IdpWorkloadSpec
{
    tenantId: string
    hiveId: string
    image: string
    port: number
    /** Secret holding the admin token under key `adminTokenRef` (mounted at <data>/secrets). */
    adminTokenSecretName: string
    adminTokenRef: string
    /** Secret holding ca.crt / server.crt / server.key (mounted at <data>/tls). */
    tlsSecretName: string
}
