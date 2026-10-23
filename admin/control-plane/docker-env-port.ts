import type { MessageConnection } from '@pragmatic-tech-ai/pragmatic-protocol'
import { BundleBuilder, type EnvDefinition, type EnvOidc } from '../../environments/seed/bundle.js'
import { DockerEnv } from '../../environments/seed/docker.js'
import { UserSeeder, type UserSeed } from '../../environments/seed/users.js'
import type { IContainerProbe } from './environment-record.js'

/** Docker seam. EnsureImage THROWS when the daemon is unreachable, resolves false when the image is missing. */
export interface IDockerEnv
{
    EnsureImage(): Promise<boolean>
    Up(def: EnvDefinition, bundleDir: string, caHostPath?: string): Promise<void>
    Down(def: EnvDefinition, removeData?: boolean): Promise<void>
    Logs(def: EnvDefinition): Promise<string>
    WaitHealthy(port: number, def: EnvDefinition): Promise<void>
    Running(containerName: string): Promise<boolean>
    RemoveVolume(def: EnvDefinition): Promise<void>
    BuildCommand(): string
}

export interface IBundleBuilder
{
    Generate(def: EnvDefinition, bundleDir: string, seedDir?: string, oidc?: EnvOidc): Promise<void>
}

export interface IUserSeeder
{
    Login(baseHttpUrl: string, tenant: string, email: string, password: string): Promise<string>
    Connect(wsUrl: string, tenant: string, token: string): Promise<unknown>
    SeedUsers(conn: unknown, users: UserSeed[]): Promise<void>
    Dispose(conn: unknown): void
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

export class BundleBuilderAdapter implements IBundleBuilder
{
    public Generate(def: EnvDefinition, bundleDir: string, seedDir?: string, oidc?: EnvOidc): Promise<void>
    {
        return BundleBuilder.Generate(def, bundleDir, seedDir, oidc)
    }
}

export class UserSeederAdapter implements IUserSeeder
{
    public constructor(private readonly seeder: UserSeeder = new UserSeeder())
    {
    }

    public Login(baseHttpUrl: string, tenant: string, email: string, password: string): Promise<string>
    {
        return this.seeder.Login(baseHttpUrl, tenant, email, password)
    }

    public Connect(wsUrl: string, tenant: string, token: string): Promise<unknown>
    {
        return this.seeder.Connect(wsUrl, tenant, token)
    }

    public SeedUsers(conn: unknown, users: UserSeed[]): Promise<void>
    {
        return this.seeder.SeedUsers(conn as MessageConnection, users)
    }

    public Dispose(conn: unknown): void
    {
        (conn as MessageConnection).dispose()
    }
}
