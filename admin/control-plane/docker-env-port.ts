import type { EnvDefinition } from '../../environments/seed/bundle.js'
import { DockerEnv, type ILogProcess } from '../../environments/seed/docker.js'
import type { IContainerProbe } from './environment-record.js'

/** Docker seam. EnsureImage THROWS when the daemon is unreachable, resolves false when the image is missing. */
export interface IDockerEnv
{
    EnsureImage(): Promise<boolean>
    Up(def: EnvDefinition, bundleDir: string, caHostPath?: string): Promise<void>
    Down(def: EnvDefinition, removeData?: boolean): Promise<void>
    Logs(def: EnvDefinition): Promise<string>
    LogStream(def: EnvDefinition, onData: (chunk: string) => void): ILogProcess
    WaitHealthy(port: number, def: EnvDefinition): Promise<void>
    Running(containerName: string): Promise<boolean>
    RemoveVolume(def: EnvDefinition): Promise<void>
    BuildCommand(): string
}

export class DockerEnvAdapter implements IDockerEnv, IContainerProbe
{
    public constructor(private readonly docker: DockerEnv = new DockerEnv())
    {
    }

    public async EnsureImage(): Promise<boolean>
    {
        await this.docker.EnsureDaemon()
        return this.docker.EnsureImage()
    }

    public Up(def: EnvDefinition, bundleDir: string, caHostPath?: string): Promise<void>
    {
        return this.docker.Up(def, bundleDir, caHostPath)
    }

    public Down(def: EnvDefinition, removeData: boolean = false): Promise<void>
    {
        return this.docker.Down(def, removeData)
    }

    public Logs(def: EnvDefinition): Promise<string>
    {
        return this.docker.Logs(def)
    }

    public LogStream(def: EnvDefinition, onData: (chunk: string) => void): ILogProcess
    {
        return this.docker.LogStream(def, onData)
    }

    public WaitHealthy(port: number, def: EnvDefinition): Promise<void>
    {
        return this.docker.WaitHealthy(port, def)
    }

    public Running(containerName: string): Promise<boolean>
    {
        return this.docker.RunningByName(containerName)
    }

    public RemoveVolume(def: EnvDefinition): Promise<void>
    {
        return this.docker.RemoveVolume(def)
    }

    public BuildCommand(): string
    {
        return DockerEnv.BuildCommand()
    }
}
