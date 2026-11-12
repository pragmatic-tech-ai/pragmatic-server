import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DevCa } from '../../src/idp/dev-ca.js'
import { IdpContainerEnv } from './idp-container-env.js'
import type { StaleImage } from './idp-container-env.js'
import { IdpStatus } from './idp-record.js'
import type { IdpRecord } from './idp-record.js'
import { IdpDriverMessages, IdpWorkloadNames } from './idp-workload-driver.js'
import type { IdpConnection, IIdpWorkloadDriver, IdpWorkloadRequest, IdpWorkloadResult } from './idp-workload-driver.js'
import type { PortAllocator } from './port-allocator.js'

/** What a reuse probe found: a reusable connection, a healthy IdP on an older build, or neither (recover it). */
interface ReuseOutcome
{
    connection?: IdpConnection
    stale?: StaleImage
}

/** Collapsed-dev driver: one docker container per tenant IdP on the platform box; pre-mints its CA on the host, provisions its admin token, seeds its data volume. */
export class DockerIdpDriver implements IIdpWorkloadDriver
{
    private static readonly IdpDirName = 'idp'
    private static readonly TlsDirName = 'tls'
    private static readonly SecretsDirName = 'secrets'
    private static readonly CaFileName = 'ca.crt'
    private static readonly AdminTokenRef = 'admin-token'
    private static readonly VolumePrefix = `${IdpWorkloadNames.NamePrefix}data-`
    private static readonly TokenBytes = 32
    private static readonly TokenEncoding = 'base64url'
    private static readonly FileEncoding = 'utf8'
    private static readonly SecretMode = 0o600
    private static readonly ReuseAttempts = 3
    private static readonly ReuseIntervalMs = 500
    private static readonly LaunchFailed = 'IdP launch failed for tenant '
    private static readonly RecoverFailed = 'IdP recovery failed for tenant (its identity volume was preserved) '

    /**
     * Per tenant: the build whose refresh failed (`current`) beside the build it fell back to (`running`), so the IdP stays on
     * its working build until the tag moves again. Held in memory only: after a control-plane restart the first refresh is
     * tried once more before it falls back again.
     */
    private readonly refusedImages = new Map<string, StaleImage>()

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
            const reuse = await this.TryReuse(existing)
            if (reuse.connection !== undefined)
            {
                return { connection: reuse.connection, record: existing }
            }
            if (reuse.stale !== undefined)
            {
                return { connection: await this.Refresh(existing, reuse.stale), record: existing }
            }
            // Unhealthy/stopped (a reboot, a Docker restart, a transient probe miss), or its tls dir was deleted to replace
            // the CA: recover IN PLACE on the same port and the same volume. The volume holds the realm, Owner accounts,
            // signing key, and every registered OIDC client, and the issuer URL (port) is baked into every already-federated
            // env bundle; a health miss must NEVER destroy that. Reserve Down+RemoveVolume for Launch's own fresh-tenant rollback.
            return { connection: await this.RecoverUnhealthy(existing), record: existing }
        }
        return this.Launch(request.tenantId, request.takenPorts)
    }

    /**
     * Recovers an unhealthy IdP on the current image, unless a refresh to the build the tag names was already refused: then
     * on the build it fell back to first, and on the tag only if that build is gone too (the tag may have moved since).
     */
    private async RecoverUnhealthy(record: IdpRecord): Promise<IdpConnection>
    {
        const refused = this.refusedImages.get(record.tenantId)
        if (refused !== undefined)
        {
            try
            {
                return await this.Recover(record, refused.running)
            }
            catch
            {
                // the fallback build is gone or broken as well: try the tag
            }
        }
        const connection = await this.Recover(record, this.image)
        this.refusedImages.delete(record.tenantId)
        return connection
    }

    /**
     * A healthy IdP runs an older build than the tag now names: recreate it on the current image. When that build cannot
     * come up, bring the IdP back on the image it ran before, and remember the refused build so later calls keep the
     * working container instead of paying a failed refresh each time (until the tag names yet another build). Any failure
     * counts, a slow first start beyond the health deadline included; rebuilding the image or restarting the control plane
     * makes it try again.
     */
    private async Refresh(record: IdpRecord, stale: StaleImage): Promise<IdpConnection>
    {
        try
        {
            const connection = await this.Recover(record, this.image)
            this.refusedImages.delete(record.tenantId)
            return connection
        }
        catch (err)
        {
            this.refusedImages.set(record.tenantId, stale)
            try
            {
                return await this.Recover(record, stale.running)
            }
            catch
            {
                throw err
            }
        }
    }

    /** Brings a stopped/unhealthy/stale existing IdP back up on its own port and volume, on `image`, without ever removing
     *  that volume. Re-seeding is a non-destructive `cp -a` (host tls/secrets merged in; realms/ untouched). A tls dir that is
     *  gone as a whole (deleted on purpose to replace an old CA) is minted afresh; a partly missing one still fails, so a CA
     *  is never replaced by accident. The realm, accounts and clients are kept. Throws if it cannot come back — the operator
     *  sees the failure rather than a silent rebuild that loses identity state. */
    private async Recover(record: IdpRecord, image: string): Promise<IdpConnection>
    {
        const dir = this.TenantDir(record.tenantId)
        try
        {
            const adminToken = readFileSync(join(dir, DockerIdpDriver.SecretsDirName, record.adminTokenRef), DockerIdpDriver.FileEncoding)
            const tlsDir = join(dir, DockerIdpDriver.TlsDirName)
            if (record.caDir === tlsDir && !existsSync(tlsDir))
            {
                DevCa.EnsureAt(tlsDir, IdpContainerEnv.ContainerHost, this.openssl)
            }
            const ca = readFileSync(join(record.caDir, DockerIdpDriver.CaFileName))
            await this.containers.Down(record.containerName)
            await this.containers.SeedVolume(record.volumeName, dir, image)
            await this.containers.Up({ tenantId: record.tenantId, port: record.port, volumeName: record.volumeName, adminTokenRef: record.adminTokenRef, image })
            await this.containers.WaitHealthy(record.port, ca)
            return { baseUrl: record.baseUrl, browserBaseUrl: record.baseUrl, ca, adminToken, adminTokenRef: record.adminTokenRef, caDir: record.caDir }
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

    /** A healthy IdP on the current build (or on a build whose refresh was already refused) is reused; a healthy one on an
     *  older build reports `stale`; anything else reports neither and is recovered. */
    private async TryReuse(record: IdpRecord): Promise<ReuseOutcome>
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
            return {}
        }
        try
        {
            await this.containers.WaitHealthy(record.port, ca, DockerIdpDriver.ReuseAttempts, DockerIdpDriver.ReuseIntervalMs)
        }
        catch
        {
            return {}
        }
        const stale = await this.containers.StaleImageOf(record.containerName, this.image)
        if (stale !== undefined && this.refusedImages.get(record.tenantId)?.current !== stale.current)
        {
            return { stale }
        }
        return { connection: { baseUrl: record.baseUrl, browserBaseUrl: record.baseUrl, ca, adminToken, adminTokenRef: record.adminTokenRef, caDir: record.caDir } }
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
            return { connection: { baseUrl, browserBaseUrl: baseUrl, ca, adminToken, adminTokenRef: DockerIdpDriver.AdminTokenRef, caDir: tlsDir }, record }
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
