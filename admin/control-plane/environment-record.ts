export enum EnvStatus
{
    Running = 'running',
    Stopped = 'stopped',
    Failed = 'failed',
    Unknown = 'unknown'
}

export enum Template
{
    DevBlank = 'dev-blank',
    DemoContoso = 'demo-contoso'
}

export type EnvironmentRecord = {
    name: string
    template: Template
    tenantId: string
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
