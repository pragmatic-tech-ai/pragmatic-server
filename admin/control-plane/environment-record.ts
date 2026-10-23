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
    hiveId?: string
    hostPort: number
    containerName: string
    volumeName: string
    bundleDir: string
    createdAt: string
    status: EnvStatus
}

export interface IContainerProbe
{
    Running(containerName: string): Promise<boolean>
}
