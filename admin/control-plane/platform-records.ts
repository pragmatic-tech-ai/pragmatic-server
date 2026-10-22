export type ClientRecord = {
    id: string
    displayName: string
    subscriptionRef?: string
    createdAt: string
}

export enum HiveBackend
{
    Aks = 'aks',
    Eks = 'eks',
    Gke = 'gke',
    Private = 'private',
    Local = 'local'
}

export enum InfraMode
{
    Provision = 'provision',
    Attach = 'attach'
}

export type ClusterSpec = {
    backend: HiveBackend
    mode: InfraMode
    configRef?: string
}

export type RegistrySpec = {
    mode: InfraMode
    endpoint?: string
    credentialRef?: string
}

export type TenantRecord = {
    id: string
    clientId: string
    displayName: string
    createdAt: string
}

export type HiveRecord = {
    id: string
    tenantId: string
    displayName: string
    cluster: ClusterSpec
    registry: RegistrySpec
    trustRootRef?: string
    agentTokenRef?: string
    createdAt: string
}

export class InvalidRecordIdError extends Error
{
    private static readonly ErrorName = 'InvalidRecordIdError'

    public constructor(message: string)
    {
        super(message)
        this.name = InvalidRecordIdError.ErrorName
    }
}

export class RecordId
{
    private static readonly InvalidIdMessage = 'invalid record id'
    private static readonly CurrentSegment = '.'
    private static readonly ParentSegment = '..'
    private static readonly SeparatorPattern = /[\\/:]/

    public static Validate(id: string): void
    {
        if (id === '' || id === RecordId.CurrentSegment || id === RecordId.ParentSegment || RecordId.SeparatorPattern.test(id))
        {
            throw new InvalidRecordIdError(RecordId.InvalidIdMessage)
        }
    }
}
