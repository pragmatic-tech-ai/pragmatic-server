export enum IdpStatus
{
    Running = 'running',
    Failed = 'failed'
}

export type IdpRecord = {
    tenantId: string
    port: number
    baseUrl: string
    containerName: string
    volumeName: string
    caDir: string
    adminTokenRef: string
    createdAt: string
    status: IdpStatus
}
