/**
 * GATED end-to-end smoke for SP-HIVE-6c-proper per-tenant IdP federation. NOT part of `npm test`.
 *
 * Requires Docker Desktop (the federated login resolves `host.docker.internal`, so this is Docker-Desktop-only)
 * and a FRESH `pragmatic-server:dev` image (rebuild it first: see admin/README.md). Run with:
 *
 *   npx tsx admin/control-plane/idp-federation-smoke.ts
 *
 * Composes the real control-plane services in-process (as server.ts does), provisions a platform tenant (which
 * launches its IdP container), creates a hive plus a bound environment (which registers an OIDC client at the IdP
 * and federates the env container), then plays the browser: env /auth/oidc/begin -> IdP login -> env callback ->
 * session. A second bound environment then rides the IdP SSO cookie with no second login. The dev CA is handed to
 * the HTTPS client in-process; no secret (owner password, tokens) is ever printed.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DockerEnv } from '../../environments/seed/docker.js'
import { UserSeeder } from '../../environments/seed/users.js'
import { BundleBuilderAdapter, DockerEnvAdapter, UserSeederAdapter } from './docker-env-port.js'
import { DockerEnvironmentRuntime } from './environment-runtime.js'
import { EnvironmentRuntimeResolver } from './environment-runtime-resolver.js'
import { HiveOrchestratorFactory } from './hive-orchestrator-factory.js'
import { EnvironmentPlacement } from './environment-placement.js'
import { InClusterEnvironmentRuntime } from './in-cluster-environment-runtime.js'
import { EnvType, Template } from './environment-record.js'
import { EnvironmentRegistry } from './environment-registry.js'
import { EnvironmentService } from './environment-service.js'
import { ClientRegistry } from './client-registry.js'
import { HiveRegistry } from './hive-registry.js'
import { TenantRegistry } from './tenant-registry.js'
import { PlatformDirectory } from './platform-directory.js'
import { HiveBackend, InfraMode } from './platform-records.js'
import { AdminProxy, WsAdminConnector } from './admin-proxy.js'
import { ExecFileDockerExec, IdpContainerEnv } from './idp-container-env.js'
import { IdpRegistry } from './idp-registry.js'
import { DockerIdpDriver } from './docker-idp-driver.js'
import { IdpService } from './idp-service.js'
import type { IdpConnection } from './idp-service.js'
import { IdpAdminClient } from './idp-admin-client.js'
import { TenantProvisioningService } from './tenant-provisioning-service.js'
import { NetPortProbe, PortAllocator } from './port-allocator.js'

/** The raw result of one browser-side exchange; redirects are read, never followed. */
class FlowResponse
{
    public constructor(
        public readonly Status: number,
        public readonly Location: string | undefined,
        public readonly SsoCookie: string | undefined,
        public readonly Body: string)
    {
    }

    public Json(): Record<string, unknown>
    {
        try
        {
            return JSON.parse(this.Body) as Record<string, unknown>
        }
        catch
        {
            return {}
        }
    }
}

/** A mutable single-cookie jar holding the IdP SSO cookie across the two env flows. */
class CookieJar
{
    private cookie: string | undefined

    public Capture(cookie: string | undefined): void
    {
        if (cookie !== undefined)
        {
            this.cookie = cookie
        }
    }

    public Value(): string | undefined
    {
        return this.cookie
    }
}

/** Plays the user-agent: raw http/https GET/POST (https trusts the supplied dev CA), redirects read not followed. */
class FlowClient
{
    private static readonly HttpsProtocol = 'https:'
    private static readonly MethodGet = 'GET'
    private static readonly MethodPost = 'POST'
    private static readonly FormContentType = 'application/x-www-form-urlencoded'
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly ContentLengthHeader = 'Content-Length'
    private static readonly CookieHeader = 'Cookie'
    private static readonly SetCookieHeader = 'set-cookie'
    private static readonly SsoCookieAssign = 'idp_sso='
    private static readonly AttributeSeparator = ';'
    private static readonly Utf8 = 'utf8'
    private static readonly DataEvent = 'data'
    private static readonly EndEvent = 'end'
    private static readonly ErrorEvent = 'error'
    private static readonly TimeoutMs = 20000
    private static readonly TimeoutMessage = 'FlowClient: request timed out'

    public constructor(private readonly ca: Buffer)
    {
    }

    public Get(url: string, cookie: string | undefined): Promise<FlowResponse>
    {
        return this.Send(FlowClient.MethodGet, url, cookie, undefined)
    }

    public PostForm(url: string, fields: ReadonlyMap<string, string>, cookie: string | undefined): Promise<FlowResponse>
    {
        return this.Send(FlowClient.MethodPost, url, cookie, new URLSearchParams([...fields]).toString())
    }

    private Send(method: string, url: string, cookie: string | undefined, body: string | undefined): Promise<FlowResponse>
    {
        const headers: Record<string, string> = {}
        if (cookie !== undefined)
        {
            headers[FlowClient.CookieHeader] = cookie
        }
        if (body !== undefined)
        {
            headers[FlowClient.ContentTypeHeader] = FlowClient.FormContentType
            headers[FlowClient.ContentLengthHeader] = String(Buffer.byteLength(body))
        }
        const secure = new URL(url).protocol === FlowClient.HttpsProtocol
        const send = secure ? httpsRequest : httpRequest
        const options = secure ? { ca: this.ca, method, headers } : { method, headers }
        return new Promise<FlowResponse>((resolve, reject) =>
        {
            const req = send(url, options, (res: IncomingMessage) =>
            {
                const chunks: Buffer[] = []
                res.on(FlowClient.DataEvent, (chunk: Buffer) => chunks.push(chunk))
                res.on(FlowClient.EndEvent, () =>
                {
                    resolve(new FlowResponse(
                        res.statusCode ?? 0,
                        res.headers.location,
                        FlowClient.ReadSsoCookie(res.headers[FlowClient.SetCookieHeader]),
                        Buffer.concat(chunks).toString(FlowClient.Utf8)))
                })
                res.on(FlowClient.ErrorEvent, reject)
            })
            req.setTimeout(FlowClient.TimeoutMs, () => req.destroy(new Error(FlowClient.TimeoutMessage)))
            req.on(FlowClient.ErrorEvent, reject)
            if (body !== undefined)
            {
                req.write(body)
            }
            req.end()
        })
    }

    /** Returns the `idp_sso=<id>` pair (no attributes) ready to resend as a Cookie header, or undefined. */
    private static ReadSsoCookie(setCookie: string[] | undefined): string | undefined
    {
        for (const header of setCookie ?? [])
        {
            const pair = header.split(FlowClient.AttributeSeparator)[0].trim()
            if (pair.startsWith(FlowClient.SsoCookieAssign))
            {
                return pair
            }
        }
        return undefined
    }
}

type BoundEnv = { name: string; port: number }

export class IdpFederationSmoke
{
    private static readonly TempPrefix = 'idp-fed-smoke-'
    private static readonly LoopbackHost = '127.0.0.1'
    private static readonly EnvPortFloor = 8100
    private static readonly IdpPortFloor = 12100
    private static readonly StaticDir = 'static'
    private static readonly RegistryFile = 'registry.json'
    private static readonly ClientsFile = 'clients.json'
    private static readonly PlatformTenantsFile = 'tenants.json'
    private static readonly HivesFile = 'hives.json'
    private static readonly IdpsFile = 'idps.json'
    private static readonly HttpPrefix = 'http://'
    private static readonly PortSep = ':'
    private static readonly HealthPath = '/healthz'
    private static readonly BeginPath = '/auth/oidc/begin'
    /** The SPA supplies its environment on pre-login requests (no session cookie yet); the host routes `/auth/*` by this hint. Key byte-matches PragmaticServerHost.EnvironmentParam. */
    private static readonly BeginQuery = '?environment='
    private static readonly CallbackPath = '/auth/oidc/callback'
    private static readonly SessionPath = '/auth/session'
    private static readonly SessionCookieName = 'ps_session'
    private static readonly CookieJoin = '='
    private static readonly TenantTokenSep = '.'
    private static readonly CodeParam = 'code'
    private static readonly StateParam = 'state'
    private static readonly TokenKey = 'token'
    private static readonly EmailKey = 'email'
    private static readonly NameKey = 'name'
    private static readonly PrincipalKey = 'principalId'
    private static readonly FormOpenTag = '<form'
    private static readonly EmailField = 'email'
    private static readonly PasswordField = 'password'
    private static readonly StatusOk = 200
    private static readonly StatusFound = 302
    private static readonly HealthAttempts = 30
    private static readonly HealthIntervalMs = 1000

    private static readonly ClientId = 'fedsmoke-client'
    private static readonly TenantId = 'fedsmoke-tenant'
    private static readonly HiveId = 'fedsmoke-hive'
    private static readonly TenantDisplayName = 'Fed Smoke Tenant'
    private static readonly HiveDisplayName = 'Fed Smoke Hive'
    private static readonly OwnerEmail = 'owner@fedsmoke.test'
    private static readonly EnvNameA = 'fedsmoke-env-a'
    private static readonly EnvNameB = 'fedsmoke-env-b'

    private static readonly PassTag = 'PASS '
    private static readonly FailTag = 'FAIL '
    private static readonly InfoTag = 'INFO '
    private static readonly DetailSep = ' -- '
    private static readonly StatusDetail = 'status='
    private static readonly OverallPass = 'OVERALL PASS: tenant IdP launched, bound env federated, real OIDC login + SSO across two environments proven'
    private static readonly OverallFail = 'OVERALL FAIL'
    private static readonly CrashPrefix = 'smoke crashed: '
    private static readonly TeardownWarning = 'WARN best-effort teardown failed: '
    private static readonly SessionKeysNote = 'session response does not expose email/name keys; principalId only'
    private static readonly NotComposed = 'smoke services not composed'

    private static readonly Labels = {
        OwnerPassword: 'idp: Provision returned a one-time owner password',
        IdpHealthy: 'idp: tenant IdP container is healthy after Provision',
        EnvAHealthy: 'env A: bound environment container is healthy',
        LoginPage: 'env A: /auth/oidc/begin 302s to the IdP authorize endpoint which serves a login form',
        LoginRedirect: 'env A: POST owner credentials -> 302 back to env A callback with code+state and an idp_sso cookie',
        Callback: 'env A: callback (container-side token exchange) returns 200 with a session token',
        SessionA: 'env A: /auth/session carries the owner identity (email/name when exposed)',
        EnvBHealthy: 'env B: second bound environment container is healthy',
        SsoRedirect: 'env B: /auth/oidc/begin rides the IdP SSO cookie -> 302 straight to env B callback, NO login page',
        CallbackB: 'env B: callback returns 200 with a session token (no second login)',
        SessionB: 'env B: /auth/session carries the same owner identity'
    }

    private failed = false
    private readonly jar = new CookieJar()
    private dataRoot = ''
    private service: EnvironmentService | undefined
    private idpService: IdpService | undefined
    private idpContainers: IdpContainerEnv | undefined
    private idpRegistry: IdpRegistry | undefined
    private readonly createdEnvs: string[] = []

    public static async Main(): Promise<void>
    {
        const smoke = new IdpFederationSmoke()
        const ok = await smoke.Run()
        console.log(ok ? IdpFederationSmoke.OverallPass : IdpFederationSmoke.OverallFail)
        process.exit(ok ? 0 : 1)
    }

    public async Run(): Promise<boolean>
    {
        const S = IdpFederationSmoke
        this.dataRoot = mkdtempSync(join(tmpdir(), S.TempPrefix))
        mkdirSync(join(this.dataRoot, S.StaticDir), { recursive: true })
        try
        {
            await this.Scenario()
        }
        catch (err)
        {
            this.failed = true
            console.log(S.CrashPrefix + (err instanceof Error ? err.message : String(err)))
        }
        finally
        {
            await this.Cleanup()
        }
        return !this.failed
    }

    private async Scenario(): Promise<void>
    {
        const S = IdpFederationSmoke
        const directory = await this.Compose()
        const provisioning = new TenantProvisioningService(this.Idp(), directory, conn => new IdpAdminClient(conn))
        await directory.CreateClient({ id: S.ClientId, displayName: S.ClientId })
        const ownerPassword = await this.ProvisionTenant(provisioning)
        if (ownerPassword === undefined)
        {
            return
        }
        // Idempotent reuse: returns the connection (CA, base url) of the IdP that Provision just launched.
        const conn = await this.Idp().EnsureForTenant(S.TenantId, S.TenantDisplayName)
        await this.CheckIdpHealthy(conn)
        await directory.CreateHive({
            id: S.HiveId,
            tenantId: S.TenantId,
            displayName: S.HiveDisplayName,
            cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach },
            registry: { mode: InfraMode.Attach }
        })
        const client = new FlowClient(conn.ca)
        const envA = await this.CreateBound(S.EnvNameA, S.Labels.EnvAHealthy)
        if (envA === undefined || !(await this.LoginEnvA(client, envA, ownerPassword)))
        {
            return
        }
        const envB = await this.CreateBound(S.EnvNameB, S.Labels.EnvBHealthy)
        if (envB !== undefined)
        {
            await this.SsoEnvB(client, envB)
        }
    }

    private Idp(): IdpService
    {
        if (this.idpService === undefined)
        {
            throw new Error(IdpFederationSmoke.NotComposed)
        }
        return this.idpService
    }

    private Envs(): EnvironmentService
    {
        if (this.service === undefined)
        {
            throw new Error(IdpFederationSmoke.NotComposed)
        }
        return this.service
    }

    /** Composes the real control-plane services under the temp dataRoot (as server.ts does). */
    private async Compose(): Promise<PlatformDirectory>
    {
        const S = IdpFederationSmoke
        const docker = new DockerEnvAdapter(new DockerEnv())
        const registry = new EnvironmentRegistry(join(this.dataRoot, S.RegistryFile), docker)
        await registry.Load()
        await registry.Reconcile()
        const directory = new PlatformDirectory(
            new ClientRegistry(join(this.dataRoot, S.ClientsFile)),
            new TenantRegistry(join(this.dataRoot, S.PlatformTenantsFile)),
            new HiveRegistry(join(this.dataRoot, S.HivesFile)),
            registry)
        await directory.Load()
        this.idpContainers = new IdpContainerEnv(new ExecFileDockerExec())
        this.idpRegistry = new IdpRegistry(join(this.dataRoot, S.IdpsFile))
        this.idpService = new IdpService(this.idpRegistry, new DockerIdpDriver(new PortAllocator(S.IdpPortFloor, new NetPortProbe()), this.idpContainers, this.dataRoot, DockerEnv.ImageName))
        this.service = new EnvironmentService(
            registry, new PortAllocator(S.EnvPortFloor, new NetPortProbe()), new EnvironmentRuntimeResolver(new DockerEnvironmentRuntime(docker, new BundleBuilderAdapter()), new InClusterEnvironmentRuntime(new HiveOrchestratorFactory(), new EnvironmentPlacement(directory), directory)), new UserSeederAdapter(new UserSeeder()),
            this.dataRoot, new AdminProxy(new WsAdminConnector()), directory, this.idpService, conn => new IdpAdminClient(conn))
        return directory
    }

    /** Provisions the tenant (launching its IdP); returns the one-time owner password (never printed). */
    private async ProvisionTenant(provisioning: TenantProvisioningService): Promise<string | undefined>
    {
        const S = IdpFederationSmoke
        const result = await provisioning.Provision({ id: S.TenantId, clientId: S.ClientId, displayName: S.TenantDisplayName, ownerEmail: S.OwnerEmail })
        const ok = typeof result.ownerPassword === 'string' && result.ownerPassword !== ''
        this.Check(S.Labels.OwnerPassword, ok)
        return ok ? result.ownerPassword : undefined
    }

    private async CheckIdpHealthy(conn: IdpConnection): Promise<void>
    {
        const S = IdpFederationSmoke
        try
        {
            await this.idpRegistry?.Load()
            const record = this.idpRegistry?.Get(S.TenantId)
            if (record === undefined || this.idpContainers === undefined)
            {
                throw new Error(S.NotComposed)
            }
            await this.idpContainers.WaitHealthy(record.port, conn.ca)
            this.Check(S.Labels.IdpHealthy, true)
        }
        catch (e)
        {
            this.Check(S.Labels.IdpHealthy, false, e instanceof Error ? e.message : String(e))
        }
    }

    /** Creates a hive-bound environment and gates its /healthz; returns it (undefined on failure). */
    private async CreateBound(name: string, label: string): Promise<BoundEnv | undefined>
    {
        const S = IdpFederationSmoke
        try
        {
            const record = await this.Envs().Create(name, Template.DevBlank, EnvType.Development, undefined, S.HiveId)
            this.createdEnvs.push(record.name)
            const ok = await this.WaitEnvHealthy(record.hostPort as number)
            this.Check(label, ok)
            return ok ? { name: record.name, port: record.hostPort as number } : undefined
        }
        catch (e)
        {
            this.Check(label, false, e instanceof Error ? e.message : String(e))
            return undefined
        }
    }

    private async WaitEnvHealthy(port: number): Promise<boolean>
    {
        const S = IdpFederationSmoke
        const client = new FlowClient(Buffer.alloc(0))
        for (let i = 0; i < S.HealthAttempts; i++)
        {
            try
            {
                const res = await client.Get(this.EnvUrl(port, S.HealthPath), undefined)
                if (res.Status === S.StatusOk)
                {
                    return true
                }
            }
            catch
            {
                // not up yet
            }
            await new Promise<void>(resolve => setTimeout(resolve, S.HealthIntervalMs))
        }
        return false
    }

    private EnvUrl(port: number, path: string): string
    {
        return IdpFederationSmoke.HttpPrefix + IdpFederationSmoke.LoopbackHost + IdpFederationSmoke.PortSep + String(port) + path
    }

    /** The begin URL carries the environment hint the SPA would add; a dev-blank env's id is its name. */
    private BeginUrl(env: BoundEnv): string
    {
        return this.EnvUrl(env.port, IdpFederationSmoke.BeginPath) + IdpFederationSmoke.BeginQuery + encodeURIComponent(env.name)
    }

    /** Rewrites an absolute URL's host to 127.0.0.1: the IdP cert carries an IP:127.0.0.1 SAN, and the container-facing host.docker.internal need not resolve on the host. */
    private HostSide(location: string | undefined): string | undefined
    {
        if (location === undefined)
        {
            return undefined
        }
        const url = new URL(location)
        url.hostname = IdpFederationSmoke.LoopbackHost
        return url.toString()
    }

    /** Env A: begin -> IdP login page -> POST credentials -> 302 to env A callback -> callback -> session. */
    private async LoginEnvA(client: FlowClient, env: BoundEnv, ownerPassword: string): Promise<boolean>
    {
        const S = IdpFederationSmoke
        const begin = await client.Get(this.BeginUrl(env), undefined)
        const authorizeUrl = this.HostSide(begin.Location)
        if (begin.Status !== S.StatusFound || authorizeUrl === undefined)
        {
            this.Check(S.Labels.LoginPage, false, S.StatusDetail + begin.Status)
            return false
        }
        const page = await client.Get(authorizeUrl, undefined)
        this.Check(S.Labels.LoginPage, page.Status === S.StatusOk && page.Body.includes(S.FormOpenTag), S.StatusDetail + page.Status)

        const form = new Map<string, string>([[S.EmailField, S.OwnerEmail], [S.PasswordField, ownerPassword]])
        const redirect = await client.PostForm(authorizeUrl, form, undefined)
        const target = this.HostSide(redirect.Location)
        const landed = redirect.Status === S.StatusFound && target !== undefined && this.IsCallbackFor(target, env.port)
        this.Check(S.Labels.LoginRedirect, landed && redirect.SsoCookie !== undefined, S.StatusDetail + redirect.Status)
        this.jar.Capture(redirect.SsoCookie)
        if (!landed || target === undefined)
        {
            return false
        }
        return this.FinishCallback(client, env, target, S.Labels.Callback, S.Labels.SessionA)
    }

    /** Env B: with the jar's IdP SSO cookie, begin must 302 through the IdP straight to env B's callback with no login page. */
    private async SsoEnvB(client: FlowClient, env: BoundEnv): Promise<void>
    {
        const S = IdpFederationSmoke
        const begin = await client.Get(this.BeginUrl(env), undefined)
        const authorizeUrl = this.HostSide(begin.Location)
        if (begin.Status !== S.StatusFound || authorizeUrl === undefined)
        {
            this.Check(S.Labels.SsoRedirect, false, S.StatusDetail + begin.Status)
            return
        }
        const redirect = await client.Get(authorizeUrl, this.jar.Value())
        const target = this.HostSide(redirect.Location)
        const sso = redirect.Status === S.StatusFound && target !== undefined && this.IsCallbackFor(target, env.port) && !redirect.Body.includes(S.FormOpenTag)
        this.Check(S.Labels.SsoRedirect, sso, S.StatusDetail + redirect.Status)
        if (sso && target !== undefined)
        {
            await this.FinishCallback(client, env, target, S.Labels.CallbackB, S.Labels.SessionB)
        }
    }

    private IsCallbackFor(target: string, port: number): boolean
    {
        const S = IdpFederationSmoke
        const url = new URL(target)
        return url.port === String(port)
            && url.pathname === S.CallbackPath
            && (url.searchParams.get(S.CodeParam) ?? '') !== ''
            && (url.searchParams.get(S.StateParam) ?? '') !== ''
    }

    /** Hits the env callback (token exchange happens in the container), then reads /auth/session with the minted token as the session cookie. */
    private async FinishCallback(client: FlowClient, env: BoundEnv, callbackUrl: string, callbackLabel: string, sessionLabel: string): Promise<boolean>
    {
        const S = IdpFederationSmoke
        const callback = await client.Get(callbackUrl, undefined)
        const token = callback.Json()[S.TokenKey]
        const hasToken = callback.Status === S.StatusOk && typeof token === 'string' && token !== ''
        this.Check(callbackLabel, hasToken, S.StatusDetail + callback.Status)
        if (!hasToken)
        {
            return false
        }
        const cookie = S.SessionCookieName + S.CookieJoin + this.EnvTenantId(env) + S.TenantTokenSep + String(token)
        const session = await client.Get(this.EnvUrl(env.port, S.SessionPath), cookie)
        const body = session.Json()
        const principal = body[S.PrincipalKey]
        let ok = session.Status === S.StatusOk && typeof principal === 'string' && principal !== ''
        const email = body[S.EmailKey]
        const name = body[S.NameKey]
        if (email === undefined && name === undefined)
        {
            console.log(S.InfoTag + S.SessionKeysNote)
        }
        else
        {
            ok = ok && email === S.OwnerEmail && typeof name === 'string' && name !== ''
        }
        this.Check(sessionLabel, ok, S.StatusDetail + session.Status)
        return ok
    }

    /** The served env's tenant id (the session-cookie tenant segment): the env name for dev-blank templates. */
    private EnvTenantId(env: BoundEnv): string
    {
        return env.name
    }

    private Check(label: string, ok: boolean, detail = ''): void
    {
        if (!ok)
        {
            this.failed = true
        }
        const suffix = ok || detail === '' ? '' : IdpFederationSmoke.DetailSep + detail
        console.log((ok ? IdpFederationSmoke.PassTag : IdpFederationSmoke.FailTag) + label + suffix)
    }

    /** Best-effort teardown: env containers + volumes, the tenant's IdP container + volume, then the temp dataRoot. */
    private async Cleanup(): Promise<void>
    {
        const S = IdpFederationSmoke
        for (const name of this.createdEnvs)
        {
            try
            {
                await this.service?.Delete(name)
            }
            catch (e)
            {
                console.log(S.TeardownWarning + (e instanceof Error ? e.message : String(e)))
            }
        }
        try
        {
            await this.idpRegistry?.Load()
            const record = this.idpRegistry?.Get(S.TenantId)
            if (record !== undefined && this.idpContainers !== undefined)
            {
                await this.idpContainers.Down(record.containerName)
                await this.idpContainers.RemoveVolume(record.volumeName)
            }
        }
        catch (e)
        {
            console.log(S.TeardownWarning + (e instanceof Error ? e.message : String(e)))
        }
        try
        {
            rmSync(this.dataRoot, { recursive: true, force: true })
        }
        catch (e)
        {
            console.log(S.TeardownWarning + (e instanceof Error ? e.message : String(e)))
        }
    }

    /** True when this module is the process entry point (not when imported). */
    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
    }
}

if (IdpFederationSmoke.IsEntryPoint())
{
    await IdpFederationSmoke.Main()
}
