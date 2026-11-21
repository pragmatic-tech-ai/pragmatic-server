import type { EnvDefinition, ILogProcess, IContainerProbe, IDockerEnv } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { DockerEnv } from '../../environments/seed/docker.js'

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
