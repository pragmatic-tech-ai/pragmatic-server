import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DevCa } from '../../src/idp/dev-ca.js'
import { IdpContainerEnv } from './idp-container-env.js'
import { IdpStatus } from './idp-record.js'
import type { IdpRecord } from './idp-record.js'
import { IdpDriverMessages } from './idp-workload-driver.js'
import type { IdpConnection, IIdpWorkloadDriver, IdpWorkloadRequest, IdpWorkloadResult } from './idp-workload-driver.js'
import type { PortAllocator } from './port-allocator.js'

/** Collapsed-dev driver: one docker container per tenant IdP on the platform box; pre-mints its CA on the host, provisions its admin token, seeds its data volume. */
export class DockerIdpDriver implements IIdpWorkloadDriver
{
    private static readonly IdpDirName = 'idp'
    private static readonly TlsDirName = 'tls'
    private static readonly SecretsDirName = 'secrets'
    private static readonly CaFileName = 'ca.crt'
    private static readonly AdminTokenRef = 'admin-token'
    private static readonly VolumePrefix = `${IdpContainerEnv.NamePrefix}data-`
    private static readonly TokenBytes = 32
    private static readonly TokenEncoding = 'base64url'
    private static readonly FileEncoding = 'utf8'
    private static readonly SecretMode = 0o600
    private static readonly ReuseAttempts = 3
    private static readonly ReuseIntervalMs = 500
    private static readonly LaunchFailed = 'IdP launch failed for tenant '
    private static readonly RecoverFailed = 'IdP recovery failed for tenant (its identity volume was preserved) '

    public constructor(
        private readonly allocator: PortAllocator,
        private readonly containers: IdpContainerEnv,
        private readonly dataRoot: string,
        private readonly image: string,
        private readonly openssl?: string)
    {
    }

    public async EnsureRunning(request: IdpWorkloadRequest): Promise<IdpWorkloadResult>
    {
        const existing = request.existing
        if (existing !== undefined && existing.status === IdpStatus.Running)
        {
            const reused = await this.TryReuse(existing)
            if (reused !== undefined)
            {
                return { connection: reused, record: existing }
            }
            // Unhealthy/stopped (a reboot, a Docker restart, a transient probe miss): recover IN PLACE on the
            // same port and the same volume. The volume holds the realm, Owner accounts, signing key, and every
            // registered OIDC client, and the issuer URL (port) is baked into every already-federated env bundle;
            // a health miss must NEVER destroy that. Reserve Down+RemoveVolume for Launch's own fresh-tenant rollback.
            return { connection: await this.Recover(existing), record: existing }
        }
        return this.Launch(request.tenantId, request.takenPorts)
    }

    /** Brings a stopped/unhealthy existing IdP back up on its own port and volume without ever removing that volume.
     *  Re-seeding is a non-destructive `cp -a` (host tls/secrets merged in; realms/ untouched). Throws if it cannot
     *  come back — the operator sees the failure rather than a silent rebuild that loses the tenant's identity state. */
    private async Recover(record: IdpRecord): Promise<IdpConnection>
    {
        const dir = this.TenantDir(record.tenantId)
        try
        {
            const ca = readFileSync(join(record.caDir, DockerIdpDriver.CaFileName))
            const adminToken = readFileSync(join(dir, DockerIdpDriver.SecretsDirName, record.adminTokenRef), DockerIdpDriver.FileEncoding)
            await this.containers.Down(record.containerName)
            await this.containers.SeedVolume(record.volumeName, dir, this.image)
            await this.containers.Up({ tenantId: record.tenantId, port: record.port, volumeName: record.volumeName, adminTokenRef: record.adminTokenRef, image: this.image })
            await this.containers.WaitHealthy(record.port, ca)
            return { baseUrl: record.baseUrl, ca, adminToken, adminTokenRef: record.adminTokenRef, caDir: record.caDir }
        }
        catch (err)
        {
            // Only the message is forwarded: the admin token is never part of any message or logged.
            const detail = IdpDriverMessages.Detail(err)
            throw new Error(`${DockerIdpDriver.RecoverFailed}${record.tenantId}${IdpDriverMessages.Separator}${detail}`)
        }
    }

    private TenantDir(tenantId: string): string
    {
        return join(this.dataRoot, DockerIdpDriver.IdpDirName, tenantId)
    }

    private async TryReuse(record: IdpRecord): Promise<IdpConnection | undefined>
    {
        let ca: Buffer
        let adminToken: string
        try
        {
            ca = readFileSync(join(record.caDir, DockerIdpDriver.CaFileName))
            adminToken = readFileSync(join(this.TenantDir(record.tenantId), DockerIdpDriver.SecretsDirName, record.adminTokenRef), DockerIdpDriver.FileEncoding)
        }
        catch
        {
            return undefined
        }
        try
        {
            await this.containers.WaitHealthy(record.port, ca, DockerIdpDriver.ReuseAttempts, DockerIdpDriver.ReuseIntervalMs)
        }
        catch
        {
            return undefined
        }
        return { baseUrl: record.baseUrl, ca, adminToken, adminTokenRef: record.adminTokenRef, caDir: record.caDir }
    }

    private async Launch(tenantId: string, takenPorts: number[]): Promise<IdpWorkloadResult>
    {
        const port = await this.allocator.Allocate(takenPorts)
        const containerName = IdpContainerEnv.ContainerName(tenantId)
        const volumeName = `${DockerIdpDriver.VolumePrefix}${tenantId}`
        const dir = this.TenantDir(tenantId)
        const tlsDir = join(dir, DockerIdpDriver.TlsDirName)
        try
        {
            const files = DevCa.EnsureAt(tlsDir, IdpContainerEnv.ContainerHost, this.openssl)
            const ca = readFileSync(files.caFile)
            const adminToken = randomBytes(DockerIdpDriver.TokenBytes).toString(DockerIdpDriver.TokenEncoding)
            const secretsDir = join(dir, DockerIdpDriver.SecretsDirName)
            mkdirSync(secretsDir, { recursive: true })
            const tokenFile = join(secretsDir, DockerIdpDriver.AdminTokenRef)
            writeFileSync(tokenFile, adminToken, { encoding: DockerIdpDriver.FileEncoding, mode: DockerIdpDriver.SecretMode })
            chmodSync(tokenFile, DockerIdpDriver.SecretMode)
            await this.containers.SeedVolume(volumeName, dir, this.image)
            await this.containers.Up({ tenantId, port, volumeName, adminTokenRef: DockerIdpDriver.AdminTokenRef, image: this.image })
            await this.containers.WaitHealthy(port, ca)
            const baseUrl = IdpContainerEnv.BaseUrl(port)
            const record: IdpRecord = {
                tenantId, port, baseUrl, containerName, volumeName, caDir: tlsDir,
                adminTokenRef: DockerIdpDriver.AdminTokenRef, createdAt: new Date().toISOString(), status: IdpStatus.Running
            }
            return { connection: { baseUrl, ca, adminToken, adminTokenRef: DockerIdpDriver.AdminTokenRef, caDir: tlsDir }, record }
        }
        catch (err)
        {
            await this.Cleanup(containerName, volumeName)
            rmSync(dir, { recursive: true, force: true })
            // Only the message is forwarded: the admin token is never part of any message or logged.
            const detail = IdpDriverMessages.Detail(err)
            throw new Error(`${DockerIdpDriver.LaunchFailed}${tenantId}${IdpDriverMessages.Separator}${detail}`)
        }
    }

    public async Discard(record: IdpRecord): Promise<void>
    {
        await this.Cleanup(record.containerName, record.volumeName)
        rmSync(this.TenantDir(record.tenantId), { recursive: true, force: true })
    }

    private async Cleanup(containerName: string, volumeName: string): Promise<void>
    {
        await this.containers.Down(containerName)
        await this.containers.RemoveVolume(volumeName)
    }
}
