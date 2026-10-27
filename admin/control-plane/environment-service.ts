import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BundleBuilder, EnvKind, type EnvDatabase, type EnvDefinition, type EnvOidc } from '../../environments/seed/bundle.js'
import { DockerEnv } from '../../environments/seed/docker.js'
import type { UserSeed } from '../../environments/seed/users.js'
import { EnvStatus, EnvType, EnvironmentChangeKind, type Template, type EnvironmentChange, type EnvironmentRecord } from './environment-record.js'
import type { EnvironmentRegistry } from './environment-registry.js'
import type { PortAllocator } from './port-allocator.js'
import { TemplateCatalog } from './template-catalog.js'
import type { AdminConnectInfo, AdminSnapshot, IAdminProxy } from './admin-proxy.js'
import type { CreateAccountParams, GrantMutationDto, IdentityConfigDto, SecurityModelDto, TokenIssuedDto, ServiceTokenSummaryDto, IssueTokenParams } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { ITenantDirectory } from './tenant-api/tenant-directory.js'
import { UnknownHiveError } from './rollout-errors.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import type { IIdpService, IdpConnection } from './idp-service.js'
import type { IdpAdminClient } from './idp-admin-client.js'
import type { ILogProcess } from '../../environments/seed/docker.js'
import type { IUserSeeder } from './docker-env-port.js'
import type { EnvEndpoint, EnvRuntimeContext } from './environment-runtime.js'
import type { EnvironmentRuntimeResolver } from './environment-runtime-resolver.js'
import type { IUiDeployActuator, UiDeployBundle } from './ui-deploy-actuator.js'

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

export class EnvironmentUiDeployUnavailableError extends Error
{
    private static readonly ErrorName = 'EnvironmentUiDeployUnavailableError'
    private static readonly MessagePrefix = 'UI deploy is unavailable for environment: '

    public constructor(envName: string)
    {
        super(EnvironmentUiDeployUnavailableError.MessagePrefix + envName)
        this.name = EnvironmentUiDeployUnavailableError.ErrorName
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

export class EnvironmentNotDevelopmentError extends Error
{
    private static readonly ErrorName = 'EnvironmentNotDevelopmentError'
    private static readonly MessagePrefix = 'Environment is not a development environment: '

    public constructor(envName: string)
    {
        super(EnvironmentNotDevelopmentError.MessagePrefix + envName)
        this.name = EnvironmentNotDevelopmentError.ErrorName
    }
}

export class EnvironmentNotRuntimeError extends Error
{
    private static readonly ErrorName = 'EnvironmentNotRuntimeError'
    private static readonly MessagePrefix = 'Environment is not a runtime environment: '

    public constructor(envName: string)
    {
        super(EnvironmentNotRuntimeError.MessagePrefix + envName)
        this.name = EnvironmentNotRuntimeError.ErrorName
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
    private static readonly HttpsPrefix = 'https://'
    private static readonly HttpPrefix = 'http://localhost:'
    private static readonly WsPrefix = 'ws://localhost:'
    private static readonly NoDatabasePrefix = 'environment has no provisioned database: '
    private static readonly SecretsFile = 'provisioned-secrets.json'
    private static readonly UsersFile = 'users.json'
    private static readonly Utf8 = 'utf8'
    private static readonly MissingSecretPrefix = 'no provisioned secret for '
    /** Must byte-match AuthHttpEndpoint.OidcCallbackPath in the served runtime. */
    private static readonly OidcCallbackPath = '/auth/oidc/callback'
    /** The callback carries its own environment hint: the IdP redirect lands with no SPA to add `?environment=`, and the host routes by that hint. The key must byte-match PragmaticServerHost.EnvironmentParam. */
    private static readonly EnvironmentQueryPrefix = '?environment='
    private static readonly OidcSecretRefSuffix = '-oidc-secret'
    private static readonly IssuerSeparator = '/'
    private static readonly DiscoverySuffix = '/.well-known/openid-configuration'
    private static readonly CaFileName = 'ca.crt'
    private static readonly OidcSecretBytes = 24
    private static readonly OidcSecretEncoding = 'base64url'
    private static readonly Redacted = '[redacted]'
    private static readonly MakerPrincipalId = 'maker'
    private static readonly MakerRoleName = 'Maker'
    private static readonly TenantKindName = 'Tenant'
    private static readonly MakerScope = 'graph-contribute'
    /** The well-known runtime principal a served environment-bound app authenticates as; holds the general read grant. */
    private static readonly AppReaderPrincipalId = 'app-reader'
    /** A read-only coarse role: Role.Viewer covers Action.Read, which the CypherProtocol.Query readTenant gate requires. */
    private static readonly AppReaderRoleName = 'Viewer'
    /** One hour: a maker token is short-lived, so a leaked one expires quickly; callers re-mint on demand. */
    private static readonly MakerTokenTtlSeconds = 3600
    /** Placeholder host port fed to TemplateCatalog.Resolve for a DNS-reached (in-cluster) env, which never publishes one. */
    private static readonly NoHostPort = 0

    /** Safe names with a Create currently running; closes the race between the existence check and the final registry Put. */
    private readonly inFlight = new Set<string>()

    /** Lifecycle-change subscribers (RULING 5): additive, signal-only; the operator broadcast is a separate channel. */
    private readonly changeCallbacks = new Set<(change: EnvironmentChange) => void>()

    public constructor(
        private readonly registry: EnvironmentRegistry,
        private readonly allocator: PortAllocator,
        private readonly runtimes: EnvironmentRuntimeResolver,
        private readonly seeder: IUserSeeder,
        private readonly dataRoot: string,
        private readonly proxy: IAdminProxy,
        private readonly directory: ITenantDirectory,
        private readonly idp: IIdpService,
        private readonly adminClientFactory: (conn: IdpConnection) => IdpAdminClient,
        private readonly uiDeployer?: IUiDeployActuator)
    {
    }

    /** Resolves the platform tenant that owns the hive and checks the hive exists; undefined when unbound. Placement is enforced at workload time. Throws UnknownHiveError before any side effect. */
    private ResolveHiveTenant(hiveId: string | undefined): string | undefined
    {
        if (hiveId === undefined)
        {
            return undefined
        }
        const hive = this.directory.GetHive(hiveId)
        if (hive === undefined)
        {
            throw new UnknownHiveError(hiveId)
        }
        return hive.tenantId
    }

    /** Registers a per-environment OIDC client at the tenant's IdP and returns the config the served app is bundled with. The secret is never logged or put in an error. */
    private async Federate(platformTenantId: string, def: EnvDefinition, port: number | undefined): Promise<{ oidc: EnvOidc; caHostPath: string; caPem: Buffer; baseDomain?: string } | undefined>
    {
        const displayName = this.directory.GetTenant(platformTenantId)?.displayName ?? platformTenantId
        let secret = ''
        try
        {
            const conn = await this.idp.EnsureForTenant(platformTenantId, displayName)
            secret = randomBytes(EnvironmentService.OidcSecretBytes).toString(EnvironmentService.OidcSecretEncoding)
            const clientId = def.environmentId
            // Host-port (Docker): http://localhost:<port>. In-cluster: the env's browser host https://<environmentId>.<baseDomain>, byte-stable across restarts.
            const inCluster = port === undefined
            let origin: string
            if (inCluster)
            {
                const baseDomain = conn.baseDomain
                // An in-cluster env with no known base domain has no browser-reachable origin, so it is not federated.
                if (baseDomain === undefined)
                {
                    return undefined
                }
                origin = EnvironmentService.HttpsPrefix + K8sManifestBuilder.EnvBrowserHostOf(def.environmentId, baseDomain)
            }
            else
            {
                origin = EnvironmentService.HttpPrefix + String(port)
            }
            const redirectUri = origin + EnvironmentService.OidcCallbackPath + EnvironmentService.EnvironmentQueryPrefix + encodeURIComponent(def.environmentId)
            await this.adminClientFactory(conn).RegisterClient(platformTenantId, { clientId, redirectUris: [redirectUri], secret })
            // The issuer is the browser-facing base (equals baseUrl on Docker); discovery/token/jwks are fetched on the internal base.
            const issuer = conn.browserBaseUrl + EnvironmentService.IssuerSeparator + encodeURIComponent(platformTenantId)
            const discoveryBase = conn.baseUrl + EnvironmentService.IssuerSeparator + encodeURIComponent(platformTenantId)
            const oidc: EnvOidc = {
                issuer,
                discoveryUrl: discoveryBase + EnvironmentService.DiscoverySuffix,
                clientId,
                redirectUri,
                secretRef: def.environmentId + EnvironmentService.OidcSecretRefSuffix,
                secret
            }
            return { oidc, caHostPath: join(conn.caDir, EnvironmentService.CaFileName), caPem: conn.ca, baseDomain: inCluster ? conn.baseDomain : undefined }
        }
        catch (err)
        {
            throw new CreateFailedError(EnvironmentService.Redact(err, secret))
        }
    }

    private static Redact(err: unknown, secret: string | undefined): string
    {
        const message = err instanceof Error ? err.message : String(err)
        return secret === undefined || secret === '' ? message : message.split(secret).join(EnvironmentService.Redacted)
    }

    public async Create(name: string, template: Template, type: EnvType, hostPort?: number, hiveId?: string): Promise<EnvironmentRecord>
    {
        const safe = TemplateCatalog.SanitizeName(name)
        const platformTenantId = this.ResolveHiveTenant(hiveId)
        if (this.registry.Get(safe) !== undefined || this.inFlight.has(safe))
        {
            throw new EnvironmentExistsError(safe)
        }
        this.inFlight.add(safe)
        try
        {
            // Select the runtime from the hive binding BEFORE any side effect: an unsupported hive backend throws
            // UnsupportedBackendError RAW here, so no port is allocated, no bundle written, and no Failed record persisted.
            const runtime = this.runtimes.ForHive(hiveId)
            const hostShaped = runtime.PublishesHostPort()

            // Only a host-port backend (Docker) allocates a host port; an in-cluster env is reached by cluster DNS.
            const port = hostShaped ? await this.AllocatePort(hostPort) : undefined
            const { def, seedDir } = TemplateCatalog.Resolve(template, safe, port ?? EnvironmentService.NoHostPort, type)
            const bundleDir = join(this.dataRoot, def.name)

            // Host-port backends federate over localhost; in-cluster backends federate over the env's browser host (when a base domain is known).
            let oidc: EnvOidc | undefined
            let caHostPath: string | undefined
            let caPem: Buffer | undefined
            let idpBaseDomain: string | undefined
            if (platformTenantId !== undefined)
            {
                const federation = await this.Federate(platformTenantId, def, port)
                if (federation !== undefined)
                {
                    oidc = federation.oidc
                    caHostPath = federation.caHostPath
                    caPem = federation.caPem
                    idpBaseDomain = federation.baseDomain
                }
            }
            const record: EnvironmentRecord = {
                name: def.name,
                template,
                type,
                environmentId: def.environmentId,
                createdAt: new Date().toISOString(),
                status: EnvStatus.Running
            }
            if (hostShaped)
            {
                // Docker-shaped fields: a host-port backend owns a published port, container, volume and local bundle.
                record.hostPort = port
                record.containerName = DockerEnv.ContainerName(def)
                record.volumeName = DockerEnv.VolumeName(def)
                record.bundleDir = bundleDir
            }
            if (idpBaseDomain !== undefined)
            {
                record.idpBaseDomain = idpBaseDomain
            }
            if (hiveId !== undefined)
            {
                record.tenantId = platformTenantId
                record.hiveId = hiveId
            }
            const ctx: EnvRuntimeContext = { def, record, bundleDir, seedDir, oidc, caHostPath, caPem }
            try
            {
                await runtime.Prepare(ctx)
            }
            catch (err)
            {
                EnvironmentService.RemoveBundleDir(bundleDir)
                throw oidc === undefined ? err : new CreateFailedError(EnvironmentService.Redact(err, oidc.secret))
            }

            let imageOk: boolean
            try
            {
                imageOk = await runtime.EnsureImage(def)
            }
            catch
            {
                EnvironmentService.RemoveBundleDir(bundleDir)
                throw new DockerUnavailableError()
            }
            if (!imageOk)
            {
                EnvironmentService.RemoveBundleDir(bundleDir)
                throw new ImageMissingError(runtime.BuildCommand())
            }

            try
            {
                record.createdAt = new Date().toISOString()
                const endpoint = await runtime.BringUp(ctx)
                record.endpoint = EnvironmentService.StoredEndpoint(endpoint)
                await runtime.WaitHealthy(ctx)
                if (def.kind === EnvKind.Demo && hostShaped)
                {
                    // Host-port (Docker) demos seed their users over the published port. A DNS-reached (in-cluster) demo has no
                    // host port to dial; its tree is projected by the seed init-container instead.
                    await this.SeedDemoUsers(def, bundleDir as string, seedDir, port as number)
                }
            }
            catch (err)
            {
                try
                {
                    await runtime.Teardown(ctx, true)
                }
                catch
                {
                    // teardown is best-effort; the Failed record and CreateFailedError must still happen
                }
                try
                {
                    await runtime.RemoveVolume(ctx)
                }
                catch
                {
                    // volume removal is best-effort too
                }
                const failed = { ...record, status: EnvStatus.Failed }
                await this.registry.Put(failed)
                this.NotifyChanged(EnvironmentChangeKind.Created, failed)
                throw new CreateFailedError(EnvironmentService.Redact(err, oidc?.secret))
            }
            await this.registry.Put(record)
            this.NotifyChanged(EnvironmentChangeKind.Created, record)
            return record
        }
        finally
        {
            this.inFlight.delete(safe)
        }
    }

    /** Reserves a host port for a Docker-backed env: honours a caller-chosen port (checked free) or allocates a fresh one. */
    private async AllocatePort(hostPort?: number): Promise<number>
    {
        const taken = this.registry.List().map(r => r.hostPort).filter((p): p is number => p !== undefined)
        if (hostPort !== undefined)
        {
            await this.allocator.Check(hostPort, taken)
            return hostPort
        }
        return await this.allocator.Allocate(taken)
    }

    public async Start(name: string): Promise<EnvironmentRecord>
    {
        const rec = this.Require(name)
        const endpoint = await this.runtimes.For(rec).Start(this.CtxOf(rec))
        return this.SetStatus({ ...rec, endpoint: EnvironmentService.StoredEndpoint(endpoint) }, EnvStatus.Running)
    }

    /** Builds, pushes, signs and rolls out a UI bundle into an in-cluster environment; returns the record carrying its appDeployment. */
    public async DeployAppToEnvironment(name: string, bundle: UiDeployBundle): Promise<EnvironmentRecord>
    {
        const rec = this.Require(name)
        const hive = rec.hiveId === undefined ? undefined : this.directory.GetHive(rec.hiveId)
        if (this.uiDeployer === undefined || hive === undefined)
        {
            throw new EnvironmentUiDeployUnavailableError(name)
        }
        return this.uiDeployer.DeployAppToEnvironment(rec, hive, bundle)
    }

    public async Stop(name: string): Promise<EnvironmentRecord>
    {
        const rec = this.Require(name)
        await this.runtimes.For(rec).Stop(this.CtxOf(rec))
        return this.SetStatus(rec, EnvStatus.Stopped)
    }

    /** Stops then starts the environment, sequentially, reusing the single-step methods; returns the final Running record. */
    public async Restart(name: string): Promise<EnvironmentRecord>
    {
        await this.Stop(name)
        return await this.Start(name)
    }

    public async Delete(name: string): Promise<void>
    {
        const rec = this.Require(name)
        const ctx = this.CtxOf(rec)
        const runtime = this.runtimes.For(rec)
        await runtime.Teardown(ctx, true)
        await runtime.RemoveVolume(ctx)
        await this.registry.Remove(name)
        this.NotifyChanged(EnvironmentChangeKind.Deleted, rec)
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

    /**
     * Brings a record's status in line with real workload readiness (called by the health monitor). Writes only
     * Running/Stopped; a Failed record is terminal and an absent or already-matching record is a no-op.
     */
    public async ReconcileStatus(name: string, ready: boolean): Promise<void>
    {
        const target = ready ? EnvStatus.Running : EnvStatus.Stopped
        const rec = this.registry.Get(name)
        if (rec === undefined)
        {
            return
        }
        if (rec.status === EnvStatus.Failed)
        {
            return
        }
        if (rec.status === target)
        {
            return
        }
        await this.SetStatus(rec, target)
    }

    private static RemoveBundleDir(bundleDir: string | undefined): void
    {
        if (bundleDir === undefined)
        {
            return
        }
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
        return this.runtimes.For(rec).Logs(this.CtxOf(rec))
    }

    public LogStream(name: string, onData: (chunk: string) => void): ILogProcess
    {
        const rec = this.Require(name)
        return this.runtimes.For(rec).LogStream(this.CtxOf(rec), onData)
    }

    public async AdminSnapshot(name: string): Promise<AdminSnapshot>
    {
        const info = await this.AdminInfoFor(name)
        return this.proxy.LoadAdmin(info)
    }

    public async AdminCreateAccount(name: string, params: CreateAccountParams): Promise<void>
    {
        const info = await this.AdminInfoFor(name)
        return this.proxy.CreateAccount(info, params)
    }

    public async AdminDisableAccount(name: string, principalId: string): Promise<void>
    {
        const info = await this.AdminInfoFor(name)
        return this.proxy.DisableAccount(info, principalId)
    }

    public async AdminGrantRole(name: string, mutation: GrantMutationDto): Promise<void>
    {
        const info = await this.AdminInfoFor(name)
        return this.proxy.GrantRole(info, mutation)
    }

    public async AdminListTokens(name: string): Promise<ServiceTokenSummaryDto[]>
    {
        const info = await this.AdminInfoFor(name)
        return this.proxy.ListTokens(info)
    }

    public async AdminIssueToken(name: string, params: IssueTokenParams): Promise<TokenIssuedDto>
    {
        const info = await this.AdminInfoFor(name)
        return this.proxy.IssueToken(info, params)
    }

    public async AdminRevokeToken(name: string, tokenRef: string): Promise<void>
    {
        const info = await this.AdminInfoFor(name)
        await this.proxy.RevokeToken(info, { tokenRef })
    }

    public async AdminIssueMakerToken(name: string): Promise<TokenIssuedDto>
    {
        const rec = this.Require(name)
        if (rec.type !== EnvType.Development)
        {
            throw new EnvironmentNotDevelopmentError(name)
        }
        const info = await this.AdminInfoFor(name)
        await this.proxy.GrantRole(info, { subject: EnvironmentService.MakerPrincipalId, role: EnvironmentService.MakerRoleName, resourceKind: EnvironmentService.TenantKindName, resourcePath: [] })
        return this.proxy.IssueToken(info, { principalId: EnvironmentService.MakerPrincipalId, scopes: [EnvironmentService.MakerScope], expiresInSeconds: EnvironmentService.MakerTokenTtlSeconds })
    }

    /** Idempotently grants the well-known app-reader principal a read-capable role on a runtime environment, as Owner via the proxy, so a served environment-bound app passes the readTenant gate without weakening authoring gates. Returns nothing: no token or secret is minted or surfaced. */
    public async AdminGrantAppReader(name: string): Promise<void>
    {
        const rec = this.Require(name)
        if (rec.type !== EnvType.Runtime)
        {
            throw new EnvironmentNotRuntimeError(name)
        }
        const info = await this.AdminInfoFor(name)
        await this.proxy.GrantRole(info, { subject: EnvironmentService.AppReaderPrincipalId, role: EnvironmentService.AppReaderRoleName, resourceKind: EnvironmentService.TenantKindName, resourcePath: [] })
    }

    public async AdminRevokeRole(name: string, mutation: GrantMutationDto): Promise<void>
    {
        const info = await this.AdminInfoFor(name)
        return this.proxy.RevokeRole(info, mutation)
    }

    public async AdminGetConfig(name: string): Promise<IdentityConfigDto>
    {
        const info = await this.AdminInfoFor(name)
        return this.proxy.GetConfig(info)
    }

    public async AdminSetConfig(name: string, config: IdentityConfigDto): Promise<void>
    {
        const info = await this.AdminInfoFor(name)
        return this.proxy.SetConfig(info, config)
    }

    public async AdminGetSecurityModel(name: string): Promise<SecurityModelDto | undefined>
    {
        const info = await this.AdminInfoFor(name)
        return this.proxy.GetSecurityModel(info)
    }

    public async AdminSetSecurityModel(name: string, securityModel: SecurityModelDto): Promise<void>
    {
        const info = await this.AdminInfoFor(name)
        return this.proxy.SetSecurityModel(info, securityModel)
    }

    /** Resolves the environment's stored Owner credential into connect info for the admin proxy. */
    public async AdminInfoFor(name: string): Promise<AdminConnectInfo>
    {
        const rec = this.Require(name)
        const secrets = await EnvironmentService.ReadSecrets(rec.bundleDir)
        return {
            httpUrl: EnvironmentService.HttpPrefix + String(rec.hostPort),
            wsUrl: EnvironmentService.WsPrefix + String(rec.hostPort),
            tenant: rec.environmentId,
            email: BundleBuilder.AdminEmailPrefix + rec.environmentId + BundleBuilder.AdminEmailSuffix,
            password: EnvironmentService.Secret(secrets, rec.environmentId + BundleBuilder.AdminSecretSuffix)
        }
    }

    /** The env's provisioned Postgres coordinates; the password is the persisted secret, not the (re-randomised) re-derived one. */
    public async DatabaseInfoFor(name: string): Promise<EnvDatabase>
    {
        const rec = this.Require(name)
        const db = EnvironmentService.DefOf(rec).database
        if (db === undefined)
        {
            throw new Error(EnvironmentService.NoDatabasePrefix + name)
        }
        const secrets = await EnvironmentService.ReadSecrets(rec.bundleDir)
        return { ...db, password: EnvironmentService.Secret(secrets, BundleBuilder.DbSecretRef(EnvironmentService.DefOf(rec), db)) }
    }

    private CtxOf(rec: EnvironmentRecord): EnvRuntimeContext
    {
        // An in-cluster record carries no bundleDir field (that field marks the Docker local bundle), but its boot
        // bundle is generated at the same data-root path in Create, so a later Start/Restart recovers it here.
        return { def: EnvironmentService.DefOf(rec), record: rec, bundleDir: rec.bundleDir ?? join(this.dataRoot, rec.name) }
    }

    private static StoredEndpoint(endpoint: EnvEndpoint): { httpUrl: string; wsUrl: string }
    {
        return { httpUrl: endpoint.httpUrl, wsUrl: endpoint.wsUrl }
    }

    private static async ReadSecrets(bundleDir: string | undefined): Promise<Record<string, string>>
    {
        return JSON.parse(await readFile(join(bundleDir as string, EnvironmentService.SecretsFile), EnvironmentService.Utf8)) as Record<string, string>
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
        this.NotifyChanged(EnvironmentChangeKind.Changed, updated)
        return updated
    }

    /**
     * Registers a lifecycle-change subscriber and returns an unsubscribe closure. Every Start/Stop/Restart funnels
     * through SetStatus, so this single seam covers each status change. It is additive and consumed only by the
     * tenant event bus; the operator broadcast remains unchanged.
     */
    public OnChanged(cb: (change: EnvironmentChange) => void): () => void
    {
        this.changeCallbacks.add(cb)
        return () => this.changeCallbacks.delete(cb)
    }

    /** Fans a lifecycle change out to the subscribers (a snapshot, so a callback may unsubscribe mid-notify). */
    private NotifyChanged(kind: EnvironmentChangeKind, record: EnvironmentRecord): void
    {
        const change: EnvironmentChange = { kind, record }
        for (const cb of [...this.changeCallbacks])
        {
            // Isolate the emitter from its listeners: a failing subscriber must neither fail the (already persisted) lifecycle action nor starve later subscribers.
            try
            {
                cb(change)
            }
            catch
            {
                // swallowed deliberately; nothing is logged so no record/secret material can leak
            }
        }
    }

    /** Re-derives the definition from the stored type, falling back to the template default (DefaultTypeFor) for legacy records with no type. */
    private static DefOf(rec: EnvironmentRecord): EnvDefinition
    {
        return TemplateCatalog.Resolve(rec.template, rec.name, rec.hostPort as number, rec.type ?? TemplateCatalog.DefaultTypeFor(rec.template)).def
    }

    private async SeedDemoUsers(def: EnvDefinition, bundleDir: string, seedDir: string, port: number): Promise<void>
    {
        const secrets = await EnvironmentService.ReadSecrets(bundleDir)
        const users = JSON.parse(await readFile(join(seedDir, EnvironmentService.UsersFile), EnvironmentService.Utf8)) as UserSeed[]
        for (const user of users)
        {
            user.password = EnvironmentService.Secret(secrets, user.passwordRef)
        }
        const adminEmail = BundleBuilder.AdminEmailPrefix + def.environmentId + BundleBuilder.AdminEmailSuffix
        const adminPw = EnvironmentService.Secret(secrets, def.environmentId + BundleBuilder.AdminSecretSuffix)
        const token = await this.seeder.Login(EnvironmentService.HttpPrefix + port, def.environmentId, adminEmail, adminPw)
        const conn = await this.seeder.Connect(EnvironmentService.WsPrefix + port, def.environmentId, token)
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
