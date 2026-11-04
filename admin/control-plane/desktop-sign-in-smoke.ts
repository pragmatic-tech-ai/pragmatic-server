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
 * environment's own socket: graph list works, a graph method outside the maker scope is refused.
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
import { BundleBuilderAdapter, DockerEnvAdapter, UserSeederAdapter } from './docker-env-port.js'
import { DockerIdpDriver } from './docker-idp-driver.js'
import { EnvironmentEndpoints } from './environment-endpoints.js'
import { EnvironmentPlacement } from './environment-placement.js'
import { EnvironmentRegistry } from './environment-registry.js'
import { EnvironmentRuntimeResolver } from './environment-runtime-resolver.js'
import { DockerEnvironmentRuntime } from './environment-runtime.js'
import { EnvironmentService } from './environment-service.js'
import { HiveOrchestratorFactory } from './hive-orchestrator-factory.js'
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
    private static readonly Base64Url = 'base64url'
    private static readonly Sha256 = 'sha256'
    private static readonly VerifierBytes = 32
    private static readonly SkippedNoPassword = 'skipped: no owner password file'
    private static readonly ClusterSkipped = 'skipped: --cluster not given'
    private static readonly OkPrefix = 'ok    '
    private static readonly FailPrefix = 'FAIL  '
    private static readonly SkipPrefix = 'skip  '
    private static readonly Overall = 'OVERALL '
    private static readonly Pass = 'PASS'
    private static readonly Fail = 'FAIL'

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
            smoke.Check('unexpected error: ' + DesktopSignInSmoke.SafeMessage(err), false)
        }
        console.log(DesktopSignInSmoke.Overall + (smoke.failures === 0 ? DesktopSignInSmoke.Pass : DesktopSignInSmoke.Fail))
        process.exit(smoke.failures === 0 ? 0 : 1)
    }

    private static ArgValue(argv: readonly string[], flag: string): string | undefined
    {
        const i = argv.indexOf(flag)
        return i >= 0 ? argv[i + 1] : undefined
    }

    /** Error text for the log; error messages here come from our own code and never carry secrets. */
    private static SafeMessage(err: unknown): string
    {
        return err instanceof Error ? err.name + ': ' + err.message : String(err)
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

    // ---------------------------------------------------------------- part (a): HTTP

    private async RunHttp(passwordFile: string | undefined): Promise<void>
    {
        const S = DesktopSignInSmoke
        const ownerEmail = this.OwnerEmailOfTarget()
        const found = await this.PostJson(this.operatorUrl + S.DiscoverPath, { email: ownerEmail })
        const tenants = (JSON.parse(found.body) as { tenants?: { id: string }[] }).tenants ?? []
        this.Check('discover known owner -> 200, found ' + String(tenants.length) + ' tenant(s)', found.status === 200 && tenants.length > 0)
        const unknown = await this.PostJson(this.operatorUrl + S.DiscoverPath, { email: S.UnknownEmail })
        this.Check('discover unknown email -> ' + String(unknown.status) + ' (want 404)', unknown.status === 404)
        const withOrigin = await this.PostJson(this.operatorUrl + S.DiscoverPath, { email: ownerEmail }, { origin: S.OriginHeaderValue })
        this.Check('discover with Origin -> ' + String(withOrigin.status) + ' (want 403)', withOrigin.status === 403)

        const tenantId = tenants[0]?.id
        const verifier = randomBytes(S.VerifierBytes).toString(S.Base64Url)
        const challenge = createHash(S.Sha256).update(verifier).digest(S.Base64Url)
        const listener = await this.OpenLoopbackListener()
        let begun: { authorizeUrl?: string } = {}
        try
        {
            const redirectUri = 'http://' + S.Loopback + ':' + String(listener.port) + S.CallbackPath
            const begin = await this.PostJson(this.tenantUrl + S.BeginPath, { tenantId, redirectUri, bindingChallenge: challenge })
            begun = begin.status === 200 ? JSON.parse(begin.body) as { authorizeUrl?: string } : {}
            const url = begun.authorizeUrl
            const shaped = url !== undefined && url.includes(S.ClientIdMarker) && url.includes(S.PkceMarker)
            this.Check('begin -> ' + String(begin.status) + (url === undefined ? '' : ', authorize host ' + new URL(url).host) + ', client_id + S256 present: ' + String(shaped), begin.status === 200 && shaped)
            if (passwordFile === undefined)
            {
                this.Skip(S.SkippedNoPassword)
            }
            else if (begun.authorizeUrl !== undefined)
            {
                await this.RunLogin(begun.authorizeUrl, redirectUri, verifier, ownerEmail, readFileSync(passwordFile, S.Utf8).trim())
            }
        }
        finally
        {
            listener.close()
        }

        const targets = await this.Request(this.tenantUrl + S.TargetsPath, 'GET')
        this.Check('targets without bearer -> ' + String(targets.status) + ' (want 401)', targets.status === 401)
        const relay = await this.RelayUpgrade(S.RelayPath + '?environment=' + S.TargetEnvName + '&action=contribute')
        this.Check('relay upgrade without bearer -> ' + String(relay) + ' (want 401)', relay === 401)
    }

    /** The full leg: password login against the IdP form, complete, targets, relay (list works, delete refused), sign-out. */
    private async RunLogin(authorizeUrl: string, redirectUri: string, verifier: string, email: string, password: string): Promise<void>
    {
        const S = DesktopSignInSmoke
        const page = await fetch(authorizeUrl, { redirect: 'manual' })
        const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
        const form = await fetch(authorizeUrl, {
            method: 'POST',
            redirect: 'manual',
            headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
            body: new URLSearchParams({ email, password }).toString(),
        })
        const location = form.headers.get('location') ?? ''
        const landed = location.startsWith(redirectUri)
        this.Check('IdP login -> ' + String(form.status) + ', redirected to the loopback callback: ' + String(landed), landed)
        if (!landed)
        {
            return
        }
        const params = new URL(location).searchParams
        const complete = await this.PostJson(this.tenantUrl + S.CompletePath, { state: params.get('state'), code: params.get('code'), bindingVerifier: verifier })
        const session = complete.status === 200 ? JSON.parse(complete.body) as { token: string } : undefined
        this.Check('complete -> ' + String(complete.status), session !== undefined)
        if (session === undefined)
        {
            return
        }
        const bearer = { authorization: 'Bearer ' + session.token }
        const targets = await this.Request(this.tenantUrl + S.TargetsPath, 'GET', bearer)
        const listed = targets.status === 200 ? JSON.parse(targets.body) as { contribute: unknown[]; publish: unknown[] } : undefined
        this.Check('targets with bearer -> ' + String(targets.status) + (listed === undefined ? '' : ', contribute ' + String(listed.contribute.length) + ', publish ' + String(listed.publish.length)), listed !== undefined)
        const client = await PragmaticClient.ConnectAsync('ws://' + new URL(this.tenantUrl).host + S.RelayPath + '?environment=' + S.TargetEnvName + '&action=contribute', { bearerToken: session.token })
        try
        {
            const graphs = await client.ListGraphs()
            this.Check('relay graph/list -> ' + String(graphs.length) + ' graph(s)', true)
            const refused = await client.DeleteGraph({ graphName: 'no-such-graph' }).then(() => undefined, (e: unknown) => (e as { code?: number }).code)
            this.Check('relay graph/delete refused with ' + String(refused) + ' (want ' + String(S.MethodNotFoundCode) + ')', refused === S.MethodNotFoundCode)
        }
        finally
        {
            await client.DisposeAsync()
        }
        const out = await this.Request(this.tenantUrl + S.SignOutPath, 'POST', bearer)
        this.Check('sign-out -> ' + String(out.status), out.status === 200 || out.status === 204)
    }

    /** The owner email of the tenant that owns the target environment, from the platform records. Never printed. */
    private OwnerEmailOfTarget(): string
    {
        const S = DesktopSignInSmoke
        const registry = JSON.parse(readFileSync(join(this.dataRoot, S.RegistryFile), S.Utf8)) as { environments: Record<string, { tenantId: string }> }
        const tenants = JSON.parse(readFileSync(join(this.dataRoot, S.TenantsFile), S.Utf8)) as { tenants: Record<string, { ownerEmail?: string }> }
        const email = tenants.tenants[registry.environments[S.TargetEnvName]?.tenantId ?? '']?.ownerEmail
        if (email === undefined)
        {
            throw new Error('the target environment\'s tenant has no owner email on record')
        }
        return email
    }

    private OpenLoopbackListener(): Promise<{ port: number; close(): void }>
    {
        return new Promise((resolve, reject) =>
        {
            const server = createServer(socket => socket.destroy())
            server.once('error', reject)
            server.listen(0, DesktopSignInSmoke.Loopback, () => resolve({ port: (server.address() as AddressInfo).port, close: () => server.close() }))
        })
    }

    private PostJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<HttpResult>
    {
        return this.Request(url, 'POST', { 'content-type': DesktopSignInSmoke.JsonType, ...headers }, JSON.stringify(body))
    }

    private Request(url: string, method: string, headers: Record<string, string> = {}, body?: string): Promise<HttpResult>
    {
        return new Promise((resolve, reject) =>
        {
            const req = request(url, { method, headers }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', c => chunks.push(c as Buffer))
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(DesktopSignInSmoke.Utf8), location: res.headers.location }))
            })
            req.on('error', reject)
            req.end(body)
        })
    }

    /** A bearer-less WebSocket upgrade attempt: resolves with the plain HTTP status that refused it (0 if it upgraded). */
    private RelayUpgrade(path: string): Promise<number>
    {
        return new Promise((resolve, reject) =>
        {
            const req = request(this.tenantUrl + path, {
                headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64') },
            })
            req.on('response', res =>
            {
                res.resume()
                resolve(res.statusCode ?? 0)
            })
            req.on('upgrade', (_res, socket) =>
            {
                socket.destroy()
                resolve(0)
            })
            req.on('error', reject)
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
        const orchestrators = new HiveOrchestratorFactory(undefined, this.dataRoot)
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
                this.Check('in-cluster env ' + S.TargetEnvName + ' is on record', false)
                return
            }
            const lease = await endpoints.UrlsFor(rec)
            try
            {
                this.Check('cluster tunnel opened', true)
                const minted = await service.AdminIssueMakerToken(S.TargetEnvName)
                this.Check('maker token minted (admin secret read from the cluster)', typeof minted.token === 'string' && minted.token.length > 0)
                const client = await PragmaticClient.ConnectAsync(lease.wsUrl + '/?environment=' + rec.environmentId, { bearerToken: minted.token })
                try
                {
                    const graphs = await client.ListGraphs()
                    this.Check('maker-token graph/list -> ' + String(graphs.length) + ' graph(s)', Array.isArray(graphs))
                    const refused = await client.CreateGraph({ graphName: 'smoke-out-of-scope', description: '' }).then(() => false, () => true)
                    this.Check('maker-token graph/create refused (outside the scope)', refused)
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
