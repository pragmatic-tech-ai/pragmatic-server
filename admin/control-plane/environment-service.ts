import { rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BundleBuilder, EnvKind, type EnvDefinition } from '../../environments/seed/bundle.js'
import { DockerEnv } from '../../environments/seed/docker.js'
import type { UserSeed } from '../../environments/seed/users.js'
import { EnvStatus, type Template, type EnvironmentRecord } from './environment-record.js'
import type { EnvironmentRegistry } from './environment-registry.js'
import type { PortAllocator } from './port-allocator.js'
import { TemplateCatalog } from './template-catalog.js'
import type { AdminConnectInfo, AdminSnapshot, IAdminProxy } from './admin-proxy.js'
import type { CreateAccountParams, GrantMutationDto, IdentityConfigDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { IDockerEnv, IBundleBuilder, IUserSeeder } from './docker-env-port.js'

export class EnvironmentExistsError extends Error
{
    private static readonly ErrorName = 'EnvironmentExistsError'
    private static readonly MessagePrefix = 'Environment already exists: '

    public constructor(envName: string)
    {
        super(EnvironmentExistsError.MessagePrefix + envName)
        this.name = EnvironmentExistsError.ErrorName
    }
}

export class EnvironmentNotFoundError extends Error
{
    private static readonly ErrorName = 'EnvironmentNotFoundError'
    private static readonly MessagePrefix = 'Environment not found: '

    public constructor(envName: string)
    {
        super(EnvironmentNotFoundError.MessagePrefix + envName)
        this.name = EnvironmentNotFoundError.ErrorName
    }
}

export class ImageMissingError extends Error
{
    private static readonly ErrorName = 'ImageMissingError'
    private static readonly MessagePrefix = 'The server image is missing. Build it once: '

    public constructor(public readonly buildCommand: string)
    {
        super(ImageMissingError.MessagePrefix + buildCommand)
        this.name = ImageMissingError.ErrorName
    }
}

export class DockerUnavailableError extends Error
{
    private static readonly ErrorName = 'DockerUnavailableError'
    private static readonly DefaultMessage = 'Docker is not reachable. Start Docker Desktop (or the Docker daemon) and try again.'

    public constructor()
    {
        super(DockerUnavailableError.DefaultMessage)
        this.name = DockerUnavailableError.ErrorName
    }
}

export class CreateFailedError extends Error
{
    private static readonly ErrorName = 'CreateFailedError'
    private static readonly MessagePrefix = 'Environment creation failed and was rolled back: '

    public constructor(public readonly reason: string)
    {
        super(CreateFailedError.MessagePrefix + reason)
        this.name = CreateFailedError.ErrorName
    }
}

/** Orchestrates environment lifecycle over the SP-ENV blocks via fakeable seams. */
export class EnvironmentService
{
    private static readonly HttpPrefix = 'http://localhost:'
    private static readonly WsPrefix = 'ws://localhost:'
    private static readonly SecretsFile = 'provisioned-secrets.json'
    private static readonly UsersFile = 'users.json'
    private static readonly Utf8 = 'utf8'
    private static readonly MissingSecretPrefix = 'no provisioned secret for '

    public constructor(
        private readonly registry: EnvironmentRegistry,
        private readonly allocator: PortAllocator,
        private readonly docker: IDockerEnv,
        private readonly bundle: IBundleBuilder,
        private readonly seeder: IUserSeeder,
        private readonly dataRoot: string,
        private readonly proxy: IAdminProxy)
    {
    }

    public async Create(name: string, template: Template, hostPort?: number): Promise<EnvironmentRecord>
    {
        const safe = TemplateCatalog.SanitizeName(name)
        if (this.registry.Get(safe) !== undefined)
        {
            throw new EnvironmentExistsError(safe)
        }
        const taken = this.registry.List().map(r => r.hostPort)
        let port: number
        if (hostPort !== undefined)
        {
            await this.allocator.Check(hostPort, taken)
            port = hostPort
        }
        else
        {
            port = await this.allocator.Allocate(taken)
        }
        const { def, seedDir } = TemplateCatalog.Resolve(template, safe, port)
        const bundleDir = join(this.dataRoot, def.name)
        await this.bundle.Generate(def, bundleDir, seedDir)

        let imageOk: boolean
        try
        {
            imageOk = await this.docker.EnsureImage()
        }
        catch
        {
            EnvironmentService.RemoveBundleDir(bundleDir)
            throw new DockerUnavailableError()
        }
        if (!imageOk)
        {
            EnvironmentService.RemoveBundleDir(bundleDir)
            throw new ImageMissingError(this.docker.BuildCommand())
        }

        const record: EnvironmentRecord = {
            name: def.name,
            template,
            tenantId: def.tenantId,
            hostPort: port,
            containerName: DockerEnv.ContainerName(def),
            volumeName: DockerEnv.VolumeName(def),
            bundleDir,
            createdAt: new Date().toISOString(),
            status: EnvStatus.Running
        }
        try
        {
            await this.docker.Up(def, bundleDir)
            await this.docker.WaitHealthy(port, def)
            if (def.kind === EnvKind.Demo)
            {
                await this.SeedDemoUsers(def, bundleDir, seedDir, port)
            }
        }
        catch (err)
        {
            try
            {
                await this.docker.Down(def)
            }
            catch
            {
                // teardown is best-effort; the Failed record and CreateFailedError must still happen
            }
            try
            {
                await this.docker.RemoveVolume(def)
            }
            catch
            {
                // volume removal is best-effort too
            }
            await this.registry.Put({ ...record, status: EnvStatus.Failed })
            throw new CreateFailedError(err instanceof Error ? err.message : String(err))
        }
        await this.registry.Put(record)
        return record
    }

    public async Start(name: string): Promise<EnvironmentRecord>
    {
        const rec = this.Require(name)
        const def = EnvironmentService.DefOf(rec)
        await this.docker.Up(def, rec.bundleDir)
        await this.docker.WaitHealthy(rec.hostPort, def)
        return this.SetStatus(rec, EnvStatus.Running)
    }

    public async Stop(name: string): Promise<EnvironmentRecord>
    {
        const rec = this.Require(name)
        await this.docker.Down(EnvironmentService.DefOf(rec))
        return this.SetStatus(rec, EnvStatus.Stopped)
    }

    public async Delete(name: string): Promise<void>
    {
        const rec = this.Require(name)
        const def = EnvironmentService.DefOf(rec)
        await this.docker.Down(def)
        await this.docker.RemoveVolume(def)
        await this.registry.Remove(name)
    }

    public List(): readonly EnvironmentRecord[]
    {
        return this.registry.List()
    }

    public async ListReconciled(): Promise<readonly EnvironmentRecord[]>
    {
        await this.registry.Reconcile()
        return this.registry.List()
    }

    private static RemoveBundleDir(bundleDir: string): void
    {
        try
        {
            rmSync(bundleDir, { recursive: true, force: true })
        }
        catch
        {
            // best-effort cleanup of the orphaned bundle
        }
    }

    public async Logs(name: string): Promise<string>
    {
        const rec = this.Require(name)
        return this.docker.Logs(EnvironmentService.DefOf(rec))
    }

    public async AdminSnapshot(name: string): Promise<AdminSnapshot>
    {
        const info = await this.AdminInfo(name)
        return this.proxy.LoadAdmin(info)
    }

    public async AdminCreateAccount(name: string, params: CreateAccountParams): Promise<void>
    {
        const info = await this.AdminInfo(name)
        return this.proxy.CreateAccount(info, params)
    }

    public async AdminDisableAccount(name: string, principalId: string): Promise<void>
    {
        const info = await this.AdminInfo(name)
        return this.proxy.DisableAccount(info, principalId)
    }

    public async AdminGrantRole(name: string, mutation: GrantMutationDto): Promise<void>
    {
        const info = await this.AdminInfo(name)
        return this.proxy.GrantRole(info, mutation)
    }

    public async AdminRevokeRole(name: string, mutation: GrantMutationDto): Promise<void>
    {
        const info = await this.AdminInfo(name)
        return this.proxy.RevokeRole(info, mutation)
    }

    public async AdminGetConfig(name: string): Promise<IdentityConfigDto>
    {
        const info = await this.AdminInfo(name)
        return this.proxy.GetConfig(info)
    }

    public async AdminSetConfig(name: string, config: IdentityConfigDto): Promise<void>
    {
        const info = await this.AdminInfo(name)
        return this.proxy.SetConfig(info, config)
    }

    /** Resolves the environment's stored Owner credential into connect info for the admin proxy. */
    private async AdminInfo(name: string): Promise<AdminConnectInfo>
    {
        const rec = this.Require(name)
        const secrets = await EnvironmentService.ReadSecrets(rec.bundleDir)
        return {
            httpUrl: EnvironmentService.HttpPrefix + String(rec.hostPort),
            wsUrl: EnvironmentService.WsPrefix + String(rec.hostPort),
            tenant: rec.tenantId,
            email: BundleBuilder.AdminEmailPrefix + rec.tenantId + BundleBuilder.AdminEmailSuffix,
            password: EnvironmentService.Secret(secrets, rec.tenantId + BundleBuilder.AdminSecretSuffix)
        }
    }

    private static async ReadSecrets(bundleDir: string): Promise<Record<string, string>>
    {
        return JSON.parse(await readFile(join(bundleDir, EnvironmentService.SecretsFile), EnvironmentService.Utf8)) as Record<string, string>
    }

    private Require(name: string): EnvironmentRecord
    {
        const rec = this.registry.Get(name)
        if (rec === undefined)
        {
            throw new EnvironmentNotFoundError(name)
        }
        return rec
    }

    private async SetStatus(rec: EnvironmentRecord, status: EnvStatus): Promise<EnvironmentRecord>
    {
        const updated = { ...rec, status }
        await this.registry.Put(updated)
        return updated
    }

    /** The record does not store kind/purpose, so re-derive the definition from its template. */
    private static DefOf(rec: EnvironmentRecord): EnvDefinition
    {
        return TemplateCatalog.Resolve(rec.template, rec.name, rec.hostPort).def
    }

    private async SeedDemoUsers(def: EnvDefinition, bundleDir: string, seedDir: string, port: number): Promise<void>
    {
        const secrets = await EnvironmentService.ReadSecrets(bundleDir)
        const users = JSON.parse(await readFile(join(seedDir, EnvironmentService.UsersFile), EnvironmentService.Utf8)) as UserSeed[]
        for (const user of users)
        {
            user.password = EnvironmentService.Secret(secrets, user.passwordRef)
        }
        const adminEmail = BundleBuilder.AdminEmailPrefix + def.tenantId + BundleBuilder.AdminEmailSuffix
        const adminPw = EnvironmentService.Secret(secrets, def.tenantId + BundleBuilder.AdminSecretSuffix)
        const token = await this.seeder.Login(EnvironmentService.HttpPrefix + port, def.tenantId, adminEmail, adminPw)
        const conn = await this.seeder.Connect(EnvironmentService.WsPrefix + port, def.tenantId, token)
        try
        {
            await this.seeder.SeedUsers(conn, users)
        }
        finally
        {
            this.seeder.Dispose(conn)
        }
    }

    private static Secret(secrets: Record<string, string>, ref: string): string
    {
        const value = secrets[ref]
        if (value === undefined)
        {
            throw new Error(EnvironmentService.MissingSecretPrefix + ref)
        }
        return value
    }
}
