import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DevCa } from '../../src/idp/dev-ca.js'
import { IdpContainerEnv } from './idp-container-env.js'
import { IdpStatus } from './idp-record.js'
import type { IdpRecord } from './idp-record.js'
import type { IdpRegistry } from './idp-registry.js'
import type { PortAllocator } from './port-allocator.js'

export interface IdpConnection
{
    baseUrl: string
    ca: Buffer
    adminToken: string
    adminTokenRef: string
    caDir: string
}

export interface IIdpService
{
    EnsureForTenant(tenantId: string, displayName: string): Promise<IdpConnection>
}

export class InvalidTenantIdError extends Error
{
    private static readonly ErrorName = 'InvalidTenantIdError'

    public constructor(message: string)
    {
        super(message)
        this.name = InvalidTenantIdError.ErrorName
    }
}

/** Launches (or reuses) one per-tenant IdP container: pre-mints its CA on the host, provisions its admin token, seeds its data volume. */
export class IdpService implements IIdpService
{
    private static readonly IdpDirName = 'idp'
    private static readonly TlsDirName = 'tls'
    private static readonly SecretsDirName = 'secrets'
    private static readonly CaFileName = 'ca.crt'
    private static readonly AdminTokenRef = 'admin-token'
    private static readonly CertHost = 'host.docker.internal'
    private static readonly VolumePrefix = 'pragmatic-idp-data-'
    private static readonly TokenBytes = 32
    private static readonly TokenEncoding = 'base64url'
    private static readonly FileEncoding = 'utf8'
    private static readonly SecretMode = 0o600
    private static readonly ReuseAttempts = 3
    private static readonly ReuseIntervalMs = 500
    private static readonly LaunchFailed = 'IdP launch failed for tenant '
    private static readonly LaunchFailedSep = ': '
    private static readonly RecoverFailed = 'IdP recovery failed for tenant (its identity volume was preserved) '
    private static readonly TenantIdPattern = /^[A-Za-z0-9-]+$/
    private static readonly InvalidTenantId = 'IdpService: invalid tenantId (only letters, digits and hyphens allowed)'

    private readonly locks = new Map<string, Promise<unknown>>()

    public constructor(
        private readonly allocator: PortAllocator,
        private readonly containers: IdpContainerEnv,
        private readonly registry: IdpRegistry,
        private readonly dataRoot: string,
        private readonly image: string,
        private readonly openssl?: string)
    {
    }

    public async EnsureForTenant(tenantId: string, displayName: string): Promise<IdpConnection>
    {
        if (!IdpService.TenantIdPattern.test(tenantId))
        {
            throw new InvalidTenantIdError(IdpService.InvalidTenantId)
        }
        const previous = this.locks.get(tenantId) ?? Promise.resolve()
        const run = previous.catch(() => undefined).then(() => this.EnsureLocked(tenantId))
        this.locks.set(tenantId, run)
        try
        {
            return await run
        }
        finally
        {
            if (this.locks.get(tenantId) === run)
            {
                this.locks.delete(tenantId)
            }
        }
    }

    private async EnsureLocked(tenantId: string): Promise<IdpConnection>
    {
        await this.registry.Load()
        const existing = this.registry.Get(tenantId)
        if (existing !== undefined && existing.status === IdpStatus.Running)
        {
            const reused = await this.TryReuse(existing)
            if (reused !== undefined)
            {
                return reused
            }
            // Unhealthy/stopped (a reboot, a Docker restart, a transient probe miss): recover IN PLACE on the
            // same port and the same volume. The volume holds the realm, Owner accounts, signing key, and every
            // registered OIDC client, and the issuer URL (port) is baked into every already-federated env bundle;
            // a health miss must NEVER destroy that. Reserve Down+RemoveVolume for Launch's own fresh-tenant rollback.
            return this.Recover(existing)
        }
        return this.Launch(tenantId)
    }

    /** Brings a stopped/unhealthy existing IdP back up on its own port and volume without ever removing that volume.
     *  Re-seeding is a non-destructive `cp -a` (host tls/secrets merged in; realms/ untouched). Throws if it cannot
     *  come back — the operator sees the failure rather than a silent rebuild that loses the tenant's identity state. */
    private async Recover(record: IdpRecord): Promise<IdpConnection>
    {
        const dir = this.TenantDir(record.tenantId)
        try
        {
            const ca = readFileSync(join(record.caDir, IdpService.CaFileName))
            const adminToken = readFileSync(join(dir, IdpService.SecretsDirName, record.adminTokenRef), IdpService.FileEncoding)
            await this.containers.Down(record.containerName)
            await this.containers.SeedVolume(record.volumeName, dir, this.image)
            await this.containers.Up({ tenantId: record.tenantId, port: record.port, volumeName: record.volumeName, adminTokenRef: record.adminTokenRef, image: this.image })
            await this.containers.WaitHealthy(record.port, ca)
            return { baseUrl: record.baseUrl, ca, adminToken, adminTokenRef: record.adminTokenRef, caDir: record.caDir }
        }
        catch (err)
        {
            // Only the message is forwarded: the admin token is never part of any message or logged.
            const detail = err instanceof Error ? err.message : String(err)
            throw new Error(`${IdpService.RecoverFailed}${record.tenantId}${IdpService.LaunchFailedSep}${detail}`)
        }
    }

    private TenantDir(tenantId: string): string
    {
        return join(this.dataRoot, IdpService.IdpDirName, tenantId)
    }

    private async TryReuse(record: IdpRecord): Promise<IdpConnection | undefined>
    {
        let ca: Buffer
        let adminToken: string
        try
        {
            ca = readFileSync(join(record.caDir, IdpService.CaFileName))
            adminToken = readFileSync(join(this.TenantDir(record.tenantId), IdpService.SecretsDirName, record.adminTokenRef), IdpService.FileEncoding)
        }
        catch
        {
            return undefined
        }
        try
        {
            await this.containers.WaitHealthy(record.port, ca, IdpService.ReuseAttempts, IdpService.ReuseIntervalMs)
        }
        catch
        {
            return undefined
        }
        return { baseUrl: record.baseUrl, ca, adminToken, adminTokenRef: record.adminTokenRef, caDir: record.caDir }
    }

    private async Launch(tenantId: string): Promise<IdpConnection>
    {
        const taken = this.registry.List().map(r => r.port)
        const port = await this.allocator.Allocate(taken)
        const containerName = IdpContainerEnv.ContainerName(tenantId)
        const volumeName = `${IdpService.VolumePrefix}${tenantId}`
        const dir = this.TenantDir(tenantId)
        const tlsDir = join(dir, IdpService.TlsDirName)
        try
        {
            const files = DevCa.EnsureAt(tlsDir, IdpService.CertHost, this.openssl)
            const ca = readFileSync(files.caFile)
            const adminToken = randomBytes(IdpService.TokenBytes).toString(IdpService.TokenEncoding)
            const secretsDir = join(dir, IdpService.SecretsDirName)
            mkdirSync(secretsDir, { recursive: true })
            const tokenFile = join(secretsDir, IdpService.AdminTokenRef)
            writeFileSync(tokenFile, adminToken, { encoding: IdpService.FileEncoding, mode: IdpService.SecretMode })
            chmodSync(tokenFile, IdpService.SecretMode)
            await this.containers.SeedVolume(volumeName, dir, this.image)
            await this.containers.Up({ tenantId, port, volumeName, adminTokenRef: IdpService.AdminTokenRef, image: this.image })
            await this.containers.WaitHealthy(port, ca)
            const baseUrl = IdpContainerEnv.BaseUrl(port)
            await this.registry.Put({
                tenantId, port, baseUrl, containerName, volumeName, caDir: tlsDir,
                adminTokenRef: IdpService.AdminTokenRef, createdAt: new Date().toISOString(), status: IdpStatus.Running
            })
            return { baseUrl, ca, adminToken, adminTokenRef: IdpService.AdminTokenRef, caDir: tlsDir }
        }
        catch (err)
        {
            await this.Cleanup(containerName, volumeName)
            rmSync(dir, { recursive: true, force: true })
            // Only the message is forwarded: the admin token is never part of any message or logged.
            const detail = err instanceof Error ? err.message : String(err)
            throw new Error(`${IdpService.LaunchFailed}${tenantId}${IdpService.LaunchFailedSep}${detail}`)
        }
    }

    private async Cleanup(containerName: string, volumeName: string): Promise<void>
    {
        await this.containers.Down(containerName)
        await this.containers.RemoveVolume(volumeName)
    }
}
