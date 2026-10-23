export enum EnvStatus
{
    Running = 'running',
    Stopped = 'stopped',
    Failed = 'failed',
    Unknown = 'unknown'
}

export enum EnvType
{
    Development = 'development',
    Runtime = 'runtime'
}

export enum Template
{
    DevBlank = 'dev-blank',
    DemoContoso = 'demo-contoso',
    RuntimePostgres = 'runtime-postgres'
}

export type EnvironmentRecord = {
    name: string
    type: EnvType
    template: Template
    environmentId: string
    /** Platform tenant (owning), from the hive. Distinct from environmentId (the data-plane scope). Unset while unbound. */
    tenantId?: string
    /** The hive this environment is placed on; unset while unbound. */
    hiveId?: string
    hostPort: number
    containerName: string
    volumeName: string
    bundleDir: string
    createdAt: string
    status: EnvStatus
}

/** The kind of lifecycle change fanned out over the environment OnChanged seam. */
export enum EnvironmentChangeKind
{
    Created = 'created',
    Changed = 'changed',
    Deleted = 'deleted'
}

/** A lifecycle change: the kind that occurred, and the record it occurred to. */
export type EnvironmentChange =
{
    kind: EnvironmentChangeKind
    record: EnvironmentRecord
}

export interface IContainerProbe
{
    Running(containerName: string): Promise<boolean>
}
