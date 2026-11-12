/**
 * GATED live smoke for the Plexus desktop sign-in + relay surface. NOT a *.test.ts and NOT in any test glob.
 *
 *   npx tsx admin/control-plane/desktop-sign-in-smoke.ts [--owner-password-file PATH] [--cluster]
 *
 * Part (a), always: HTTP checks against a RUNNING control plane (operator listener http://localhost:7000, tenant plane
 * http://127.0.0.1:7002; override with PRAGMATIC_SMOKE_OPERATOR_URL / PRAGMATIC_SMOKE_TENANT_URL): desktop discovery
 * (found / unknown / Origin refused), sign-in begin (authorize URL), and the unauthenticated refusals of targets and the
 * relay upgrade. The full browser-less login + relay leg runs only when --owner-password-file is given (the file holds
 * the tenant Owner's password; it is read, never printed).
 *
 * Part (b), --cluster: composes the real KubectlCli / ClusterTunnelPool / EnvironmentEndpoints / EnvironmentService over
 * the hive data root in-process, mints a maker token for the in-cluster Development env and exercises it over the
 * environment's own socket: graph list works, a graph method outside the maker scope is refused with the scope error.
 *
 * Only statuses and counts are printed: never tokens, passwords, emails or secret content.
 */
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import { DockerEnv } from '../../environments/seed/docker.js'
import { UserSeeder } from '../../environments/seed/users.js'
import { AdminProxy, WsAdminConnector } from './admin-proxy.js'
import { ClientRegistry } from './client-registry.js'
import { ClusterTunnelPool } from './cluster-tunnel-pool.js'
import { DockerEnvAdapter } from './docker-env-port.js'
import { BundleBuilderAdapter, UserSeederAdapter } from './environment-seed-port.js'
import { DockerIdpDriver } from './docker-idp-driver.js'
import { EnvironmentEndpoints } from './environment-endpoints.js'
import { EnvironmentPlacement } from './environment-placement.js'
import { EnvironmentRegistry } from './environment-registry.js'
import { EnvironmentRuntimeResolver } from './environment-runtime-resolver.js'
import { DockerEnvironmentRuntime } from './environment-runtime.js'
import { EnvironmentService } from './environment-service.js'
import { KindHiveOrchestratorFactory } from './kind-hive-orchestrator-factory.js'
import { HiveRegistry } from './hive-registry.js'
import { IdpAdminClient } from './idp-admin-client.js'
import { ExecFileDockerExec, IdpContainerEnv } from './idp-container-env.js'
import { IdpRegistry } from './idp-registry.js'
import { IdpService } from './idp-service.js'
import { InClusterEnvironmentRuntime } from './in-cluster-environment-runtime.js'
import { NodeProcessSpawner } from './kubectl.js'
import { PlatformDirectory } from './platform-directory.js'
import { NetPortProbe, PortAllocator } from './port-allocator.js'
import { TenantRegistry } from './tenant-registry.js'

type HttpResult = { status: number; body: string; location?: string }

/** The smoke driver. Every check prints one `ok` / `FAIL` line; the process exit code is the overall verdict. */
export class DesktopSignInSmoke
{
    private static readonly OperatorUrlEnv = 'PRAGMATIC_SMOKE_OPERATOR_URL'
    private static readonly TenantUrlEnv = 'PRAGMATIC_SMOKE_TENANT_URL'
    private static readonly DefaultOperatorUrl = 'http://localhost:7000'
    private static readonly DefaultTenantUrl = 'http://127.0.0.1:7002'
    private static readonly PasswordFileFlag = '--owner-password-file'
    private static readonly ClusterFlag = '--cluster'
    private static readonly DataDir = 'data'
    private static readonly TenantsFile = 'tenants.json'
    private static readonly RegistryFile = 'registry.json'
    private static readonly ClientsFile = 'clients.json'
    private static readonly HivesFile = 'hives.json'
    private static readonly IdpsFile = 'idps.json'
    private static readonly TargetEnvName = 'training2'
    private static readonly Utf8 = 'utf8'
    private static readonly Loopback = '127.0.0.1'
    private static readonly CallbackPath = '/pragmatic-desktop/callback'
    private static readonly DiscoverPath = '/api/desktop/discover'
    private static readonly BeginPath = '/desktop/sign-in/begin'
    private static readonly CompletePath = '/desktop/sign-in/complete'
    private static readonly SignOutPath = '/desktop/sign-out'
    private static readonly TargetsPath = '/desktop/targets'
    private static readonly RelayPath = '/desktop/relay'
    private static readonly JsonType = 'application/json'
    private static readonly OriginHeaderValue = 'http://evil.example'
    private static readonly UnknownEmail = 'nobody-at-all@unknown.invalid'
    private static readonly ClientIdMarker = 'client_id=pragmatic-desktop'
    private static readonly PkceMarker = 'code_challenge_method=S256'
    private static readonly MethodNotFoundCode = -32601
    private static readonly InvalidRequestCode = -32600
    private static readonly ScopeRefusalText = 'outside this credential'
    private static readonly RoleRefusalText = 'no grant covers this action'
    private static readonly WarnPrefix = 'warn  '
    private static readonly LabelClusterRoleOnly = 'maker-token graph/delete refused by role; this environment server image predates scope enforcement'
    private static readonly Base64Url = 'base64url'
    private static readonly Base64 = 'base64'
    private static readonly Sha256 = 'sha256'
    private static readonly VerifierBytes = 32
    private static readonly WsKeyBytes = 16
    private static readonly RequestTimeoutMs = 15000
    private static readonly MethodGet = 'GET'
    private static readonly MethodPost = 'POST'
    private static readonly HeaderContentType = 'content-type'
    private static readonly HeaderAuthorization = 'authorization'
    private static readonly HeaderCookie = 'cookie'
    private static readonly HeaderOrigin = 'origin'
    private static readonly HeaderSetCookie = 'set-cookie'
    private static readonly HeaderLocation = 'location'
    private static readonly HeaderConnection = 'connection'
    private static readonly HeaderUpgrade = 'upgrade'
    private static readonly HeaderWsVersion = 'sec-websocket-version'
    private static readonly HeaderWsKey = 'sec-websocket-key'
    private static readonly UpgradeValue = 'Upgrade'
    private static readonly WebsocketValue = 'websocket'
    private static readonly WsVersionValue = '13'
    private static readonly FormType = 'application/x-www-form-urlencoded'
    private static readonly BearerPrefix = 'Bearer '
    private static readonly Redirect = 'manual'
    private static readonly Http = 'http://'
    private static readonly Ws = 'ws://'
    private static readonly EnvQuery = '?environment='
    private static readonly ActionContribute = '&action=contribute'
    private static readonly EnvironmentParam = '/?environment='
    private static readonly Colon = ':'
    private static readonly Semicolon = ';'
    private static readonly Empty = ''
    private static readonly StateParam = 'state'
    private static readonly CodeParam = 'code'
    private static readonly EmailField = 'email'
    private static readonly PasswordField = 'password'
    private static readonly MissingGraph = 'no-such-graph'
    private static readonly EventError = 'error'
    private static readonly EventTimeout = 'timeout'
    private static readonly EventResponse = 'response'
    private static readonly EventUpgrade = 'upgrade'
    private static readonly EventData = 'data'
    private static readonly EventEnd = 'end'
    private static readonly OwnerEmailMissing = 'the target environment tenant has no owner email on record'
    private static readonly TimeoutMessage = 'request timed out'
    private static readonly SkippedNoPassword = 'skipped: no owner password file'
    private static readonly ClusterSkipped = 'skipped: --cluster not given'
    private static readonly OkPrefix = 'ok    '
    private static readonly FailPrefix = 'FAIL  '
    private static readonly SkipPrefix = 'skip  '
    private static readonly Overall = 'OVERALL '
    private static readonly Pass = 'PASS'
    private static readonly Fail = 'FAIL'
    private static readonly UnexpectedLabel = 'unexpected error during the smoke run, error name '
    private static readonly BeginNoUrlLabel = 'begin returned 200 without an authorize URL'
    private static readonly LabelDiscoverKnown = 'discover known owner -> 200 with at least one tenant, found '
    private static readonly LabelDiscoverUnknown = 'discover unknown email -> 404, got '
    private static readonly LabelDiscoverOrigin = 'discover with Origin -> 403, got '
    private static readonly LabelBegin = 'begin -> 200 with an authorize URL carrying client_id and S256, status '
    private static readonly LabelAuthorizeHost = ', authorize host '
    private static readonly LabelTargets401 = 'targets without bearer -> 401, got '
    private static readonly LabelRelay401 = 'relay upgrade without bearer -> 401, got '
    private static readonly LabelLogin = 'IdP login redirected to the loopback callback, status '
    private static readonly LabelComplete = 'complete -> 200, got '
    private static readonly LabelTargetsAuthed = 'targets with bearer -> 200, got '
    private static readonly LabelRelayList = 'relay graph/list returned a list, count '
    private static readonly LabelRelayDelete = 'relay graph/delete refused with -32601, got '
    private static readonly LabelSignOut = 'sign-out -> 200 or 204, got '
    private static readonly LabelEnvOnRecord = 'in-cluster env training2 is on record'
    private static readonly LabelTunnel = 'cluster tunnel opened'
    private static readonly LabelMinted = 'maker token minted (admin secret read from the cluster)'
    private static readonly LabelClusterList = 'maker-token graph/list returned a list, count '
    private static readonly LabelClusterScope = 'maker-token graph/delete refused as outside the credential scope (InvalidRequest), got code '

    private failures = 0
    private readonly operatorUrl = process.env[DesktopSignInSmoke.OperatorUrlEnv] ?? DesktopSignInSmoke.DefaultOperatorUrl
    private readonly tenantUrl = process.env[DesktopSignInSmoke.TenantUrlEnv] ?? DesktopSignInSmoke.DefaultTenantUrl
    private readonly dataRoot = join(dirname(fileURLToPath(import.meta.url)), DesktopSignInSmoke.DataDir)

    public static async Main(argv: readonly string[]): Promise<void>
    {
        const smoke = new DesktopSignInSmoke()
        try
        {
            await smoke.RunHttp(DesktopSignInSmoke.ArgValue(argv, DesktopSignInSmoke.PasswordFileFlag))
            if (argv.includes(DesktopSignInSmoke.ClusterFlag))
            {
                await smoke.RunCluster()
            }
            else
            {
                smoke.Skip(DesktopSignInSmoke.ClusterSkipped)
            }
        }
        catch (err)
        {
            smoke.Check(DesktopSignInSmoke.UnexpectedLabel + DesktopSignInSmoke.SafeName(err), false)
        }
        console.log(DesktopSignInSmoke.Overall + (smoke.failures === 0 ? DesktopSignInSmoke.Pass : DesktopSignInSmoke.Fail))
        process.exit(smoke.failures === 0 ? 0 : 1)
    }

    private static ArgValue(argv: readonly string[], flag: string): string | undefined
    {
        const i = argv.indexOf(flag)
        return i >= 0 ? argv[i + 1] : undefined
    }

    /** Only the error class name is logged: messages can quote request or secret material. */
    private static SafeName(err: unknown): string
    {
        return err instanceof Error ? err.name : typeof err
    }

    private Check(label: string, ok: boolean): boolean
    {
        console.log((ok ? DesktopSignInSmoke.OkPrefix : DesktopSignInSmoke.FailPrefix) + label)
        if (!ok)
        {
            this.failures++
        }
        return ok
    }

    private Skip(label: string): void
    {
        console.log(DesktopSignInSmoke.SkipPrefix + label)
    }

    /** A finding worth the operator's attention that does not fail the smoke. */
    private Warn(label: string): void
    {
        console.log(DesktopSignInSmoke.WarnPrefix + label)
    }

    // ---------------------------------------------------------------- part (a): HTTP

    private async RunHttp(passwordFile: string | undefined): Promise<void>
    {
        const S = DesktopSignInSmoke
        const ownerEmail = this.OwnerEmailOfTarget()
        const found = await this.PostJson(this.operatorUrl + S.DiscoverPath, { [S.EmailField]: ownerEmail })
        const tenants = (JSON.parse(found.body) as { tenants?: { id: string }[] }).tenants ?? []
        this.Check(S.LabelDiscoverKnown + String(tenants.length), found.status === 200 && tenants.length > 0)
        const unknown = await this.PostJson(this.operatorUrl + S.DiscoverPath, { [S.EmailField]: S.UnknownEmail })
        this.Check(S.LabelDiscoverUnknown + String(unknown.status), unknown.status === 404)
        const withOrigin = await this.PostJson(this.operatorUrl + S.DiscoverPath, { [S.EmailField]: ownerEmail }, { [S.HeaderOrigin]: S.OriginHeaderValue })
        this.Check(S.LabelDiscoverOrigin + String(withOrigin.status), withOrigin.status === 403)

        const tenantId = tenants[0]?.id
        const verifier = randomBytes(S.VerifierBytes).toString(S.Base64Url)
        const challenge = createHash(S.Sha256).update(verifier).digest(S.Base64Url)
        const listener = await this.OpenLoopbackListener()
        try
        {
            const redirectUri = S.Http + S.Loopback + S.Colon + String(listener.port) + S.CallbackPath
            const begin = await this.PostJson(this.tenantUrl + S.BeginPath, { tenantId, redirectUri, bindingChallenge: challenge })
            const url = begin.status === 200 ? (JSON.parse(begin.body) as { authorizeUrl?: string }).authorizeUrl : undefined
            const shaped = url !== undefined && url.includes(S.ClientIdMarker) && url.includes(S.PkceMarker)
            this.Check(S.LabelBegin + String(begin.status) + (url === undefined ? S.Empty : S.LabelAuthorizeHost + new URL(url).host), shaped)
            if (begin.status === 200 && url === undefined)
            {
                this.Check(S.BeginNoUrlLabel, false)
            }
            if (passwordFile === undefined)
            {
                this.Skip(S.SkippedNoPassword)
            }
            else if (url !== undefined)
            {
                await this.RunLogin(url, redirectUri, verifier, ownerEmail, readFileSync(passwordFile, S.Utf8).trim())
            }
        }
        finally
        {
            listener.close()
        }

        const targets = await this.Request(this.tenantUrl + S.TargetsPath, S.MethodGet)
        this.Check(S.LabelTargets401 + String(targets.status), targets.status === 401)
        const relay = await this.RelayUpgrade(S.RelayPath + S.EnvQuery + S.TargetEnvName + S.ActionContribute)
        this.Check(S.LabelRelay401 + String(relay), relay === 401)
    }

    /** The full leg: password login against the IdP form, complete, targets, relay (list works, delete refused), sign-out. */
    private async RunLogin(authorizeUrl: string, redirectUri: string, verifier: string, email: string, password: string): Promise<void>
    {
        const S = DesktopSignInSmoke
        const page = await this.Fetch(authorizeUrl, { redirect: S.Redirect })
        const cookie = (page.headers.get(S.HeaderSetCookie) ?? S.Empty).split(S.Semicolon)[0] ?? S.Empty
        const form = await this.Fetch(authorizeUrl, {
            method: S.MethodPost,
            redirect: S.Redirect,
            headers: { [S.HeaderContentType]: S.FormType, [S.HeaderCookie]: cookie },
            body: new URLSearchParams({ [S.EmailField]: email, [S.PasswordField]: password }).toString(),
        })
        const location = form.headers.get(S.HeaderLocation) ?? S.Empty
        const landed = location.startsWith(redirectUri)
        this.Check(S.LabelLogin + String(form.status), landed)
        if (!landed)
        {
            return
        }
        const params = new URL(location).searchParams
        const complete = await this.PostJson(this.tenantUrl + S.CompletePath, { state: params.get(S.StateParam), code: params.get(S.CodeParam), bindingVerifier: verifier })
        const session = complete.status === 200 ? JSON.parse(complete.body) as { token: string } : undefined
        this.Check(S.LabelComplete + String(complete.status), session !== undefined)
        if (session === undefined)
        {
            return
        }
        const bearer = { [S.HeaderAuthorization]: S.BearerPrefix + session.token }
        try
        {
            const targets = await this.Request(this.tenantUrl + S.TargetsPath, S.MethodGet, bearer)
            this.Check(S.LabelTargetsAuthed + String(targets.status), targets.status === 200)
            const client = await PragmaticClient.ConnectAsync(S.Ws + new URL(this.tenantUrl).host + S.RelayPath + S.EnvQuery + S.TargetEnvName + S.ActionContribute, { bearerToken: session.token })
            try
            {
                const graphs = await client.ListGraphs()
                this.Check(S.LabelRelayList + String(graphs.length), Array.isArray(graphs))
                const refused = await client.DeleteGraph({ graphName: S.MissingGraph }).then(() => undefined, (e: unknown) => (e as { code?: number }).code)
                this.Check(S.LabelRelayDelete + String(refused), refused === S.MethodNotFoundCode)
            }
            finally
            {
                await client.DisposeAsync()
            }
        }
        finally
        {
            const out = await this.Request(this.tenantUrl + S.SignOutPath, S.MethodPost, bearer)
            this.Check(S.LabelSignOut + String(out.status), out.status === 200 || out.status === 204)
        }
    }

    /** fetch with a hard timeout. */
    private Fetch(url: string, init: RequestInit): Promise<Response>
    {
        return fetch(url, { ...init, signal: AbortSignal.timeout(DesktopSignInSmoke.RequestTimeoutMs) })
    }

    /** The owner email of the tenant that owns the target environment, from the platform records. Never printed. */
    private OwnerEmailOfTarget(): string
    {
        const S = DesktopSignInSmoke
        const registry = JSON.parse(readFileSync(join(this.dataRoot, S.RegistryFile), S.Utf8)) as { environments: Record<string, { tenantId: string }> }
        const tenants = JSON.parse(readFileSync(join(this.dataRoot, S.TenantsFile), S.Utf8)) as { tenants: Record<string, { ownerEmail?: string }> }
        const email = tenants.tenants[registry.environments[S.TargetEnvName]?.tenantId ?? S.Empty]?.ownerEmail
        if (email === undefined)
        {
            throw new Error(S.OwnerEmailMissing)
        }
        return email
    }

    private OpenLoopbackListener(): Promise<{ port: number; close(): void }>
    {
        return new Promise((resolve, reject) =>
        {
            const server = createServer(socket => socket.destroy())
            server.once(DesktopSignInSmoke.EventError, reject)
            server.listen(0, DesktopSignInSmoke.Loopback, () => resolve({ port: (server.address() as AddressInfo).port, close: () => server.close() }))
        })
    }

    private PostJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<HttpResult>
    {
        return this.Request(url, DesktopSignInSmoke.MethodPost, { [DesktopSignInSmoke.HeaderContentType]: DesktopSignInSmoke.JsonType, ...headers }, JSON.stringify(body))
    }

    private Request(url: string, method: string, headers: Record<string, string> = {}, body?: string): Promise<HttpResult>
    {
        const S = DesktopSignInSmoke
        return new Promise((resolve, reject) =>
        {
            const req = request(url, { method, headers, timeout: S.RequestTimeoutMs }, res =>
            {
                const chunks: Buffer[] = []
                res.on(S.EventData, c => chunks.push(c as Buffer))
                res.on(S.EventEnd, () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(S.Utf8), location: res.headers.location }))
            })
            req.on(S.EventTimeout, () => req.destroy(new Error(S.TimeoutMessage)))
            req.on(S.EventError, reject)
            req.end(body)
        })
    }

    /** A bearer-less WebSocket upgrade attempt: resolves with the plain HTTP status that refused it (0 if it upgraded). */
    private RelayUpgrade(path: string): Promise<number>
    {
        const S = DesktopSignInSmoke
        return new Promise((resolve, reject) =>
        {
            const req = request(this.tenantUrl + path, {
                timeout: S.RequestTimeoutMs,
                headers: {
                    [S.HeaderConnection]: S.UpgradeValue,
                    [S.HeaderUpgrade]: S.WebsocketValue,
                    [S.HeaderWsVersion]: S.WsVersionValue,
                    [S.HeaderWsKey]: randomBytes(S.WsKeyBytes).toString(S.Base64),
                },
            })
            req.on(S.EventTimeout, () => req.destroy(new Error(S.TimeoutMessage)))
            req.on(S.EventResponse, res =>
            {
                res.resume()
                resolve(res.statusCode ?? 0)
            })
            req.on(S.EventUpgrade, (_res, socket) =>
            {
                socket.destroy()
                resolve(0)
            })
            req.on(S.EventError, reject)
            req.end()
        })
    }

    // ---------------------------------------------------------------- part (b): in-cluster maker token

    private async RunCluster(): Promise<void>
    {
        const S = DesktopSignInSmoke
        const docker = new DockerEnvAdapter(new DockerEnv())
        const registry = new EnvironmentRegistry(join(this.dataRoot, S.RegistryFile), docker)
        await registry.Load()
        const directory = new PlatformDirectory(
            new ClientRegistry(join(this.dataRoot, S.ClientsFile)),
            new TenantRegistry(join(this.dataRoot, S.TenantsFile)),
            new HiveRegistry(join(this.dataRoot, S.HivesFile)),
            registry)
        await directory.Load()
        const orchestrators = new KindHiveOrchestratorFactory(undefined, this.dataRoot)
        const placement = new EnvironmentPlacement(directory)
        const bundle = new BundleBuilderAdapter()
        const idp = new IdpService(new IdpRegistry(join(this.dataRoot, S.IdpsFile)), new DockerIdpDriver(new PortAllocator(0, new NetPortProbe()), new IdpContainerEnv(new ExecFileDockerExec()), this.dataRoot, DockerEnv.ImageName))
        const tunnels = new ClusterTunnelPool()
        const endpoints = new EnvironmentEndpoints(orchestrators, directory, tunnels, new NodeProcessSpawner())
        const service = new EnvironmentService(
            registry,
            new PortAllocator(0, new NetPortProbe()),
            new EnvironmentRuntimeResolver(new DockerEnvironmentRuntime(docker, bundle), new InClusterEnvironmentRuntime(orchestrators, placement, directory, bundle), directory, orchestrators),
            new UserSeederAdapter(new UserSeeder()),
            this.dataRoot,
            new AdminProxy(new WsAdminConnector()),
            directory,
            idp,
            conn => new IdpAdminClient(conn),
            undefined,
            endpoints)
        const rec = registry.Get(S.TargetEnvName)
        try
        {
            if (rec === undefined)
            {
                this.Check(S.LabelEnvOnRecord, false)
                return
            }
            const lease = await endpoints.UrlsFor(rec)
            try
            {
                this.Check(S.LabelTunnel, true)
                const minted = await service.AdminIssueMakerToken(S.TargetEnvName)
                this.Check(S.LabelMinted, typeof minted.token === 'string' && minted.token.length > 0)
                const client = await PragmaticClient.ConnectAsync(lease.wsUrl + S.EnvironmentParam + rec.environmentId, { bearerToken: minted.token })
                try
                {
                    const graphs = await client.ListGraphs()
                    this.Check(S.LabelClusterList + String(graphs.length), Array.isArray(graphs))
                    // Non-mutating probe: the scope gate answers before the method runs, so nothing is ever deleted.
                    const refusal = await client.DeleteGraph({ graphName: S.MissingGraph }).then(() => undefined, (e: unknown) => e as { code?: number; message?: string })
                    const text = refusal?.message ?? S.Empty
                    const invalid = refusal?.code === S.InvalidRequestCode
                    if (invalid && text.includes(S.RoleRefusalText))
                    {
                        this.Warn(S.LabelClusterRoleOnly)
                    }
                    else
                    {
                        this.Check(S.LabelClusterScope + String(refusal?.code), invalid && text.includes(S.ScopeRefusalText))
                    }
                }
                finally
                {
                    await client.DisposeAsync()
                }
            }
            finally
            {
                lease.Release()
            }
        }
        finally
        {
            tunnels.CloseAll()
        }
    }
}

await DesktopSignInSmoke.Main(process.argv.slice(2))
