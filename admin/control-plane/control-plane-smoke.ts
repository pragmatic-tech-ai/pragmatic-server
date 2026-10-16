/**
 * GATED integration smoke for the control plane. NOT part of `tsx --test`.
 *
 * Requires Docker running and the `pragmatic-server:dev` image built (one-time build:
 * see admin/README.md). Run with:
 *
 *   npx tsx admin/control-plane/control-plane-smoke.ts
 *
 * Composes the real stack in-process (as server.ts does), then drives the control-plane
 * HTTP API through create/start/stop/delete for dev-blank and demo-contoso, and verifies
 * the seeded demo users over the admin protocol.
 */
import { request } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AdminProtocol } from '@pragmatic-tech-ai/pragmatic-protocol'
import { DockerEnv } from '../../environments/seed/docker.js'
import { UserSeeder } from '../../environments/seed/users.js'
import { ControlPlaneHost } from './control-plane-host.js'
import type { EnvironmentDto } from './control-plane-host.js'
import { BundleBuilderAdapter, DockerEnvAdapter, UserSeederAdapter } from './docker-env-port.js'
import { EnvStatus, Template } from './environment-record.js'
import { EnvironmentRegistry } from './environment-registry.js'
import { EnvironmentService } from './environment-service.js'
import { OperatorIdentity } from './operator-identity.js'
import { NetPortProbe, PortAllocator } from './port-allocator.js'

type HttpResult = { status: number; json: unknown; setCookie: string[] }

export class ControlPlaneSmoke
{
    private static readonly LoopbackHost = '127.0.0.1'
    private static readonly EnvPortFloor = 8100
    private static readonly TempPrefix = 'cp-smoke-'
    private static readonly RegistryFile = 'registry.json'
    private static readonly StaticDir = 'static'
    private static readonly SecretsFile = 'provisioned-secrets.json'
    private static readonly Utf8 = 'utf8'
    private static readonly EnvironmentsPath = '/api/environments'
    private static readonly PathSep = '/'
    private static readonly StopAction = '/stop'
    private static readonly StartAction = '/start'
    private static readonly HealthPath = '/healthz'
    private static readonly MethodGet = 'GET'
    private static readonly MethodPost = 'POST'
    private static readonly MethodDelete = 'DELETE'
    private static readonly JsonContentType = 'application/json'
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly DevName = 'smoke-dev'
    private static readonly DemoName = 'smoke-demo'
    private static readonly DemoTenant = 'contoso'
    private static readonly HttpPrefix = 'http://localhost:'
    private static readonly WsPrefix = 'ws://localhost:'
    private static readonly AdminEmail = 'admin@contoso.test'
    private static readonly AdminPwKey = 'contoso-admin-pw'
    private static readonly DemoPrincipals: readonly string[] = ['rep-boston', 'rep-atlanta', 'manager-north', 'finance']
    private static readonly OperatorEmail = 'smoke-operator@control-plane.test'
    private static readonly OperatorPassword = 'smoke-operator-test-password'
    private static readonly IdentityDir = 'identity'
    private static readonly MasterKeyFile = 'master.key'
    private static readonly LoginPath = '/api/login'
    private static readonly SessionCookieName = 'cp_session'
    private static readonly CookieHeader = 'Cookie'
    private static readonly SetCookieHeader = 'set-cookie'
    private static readonly CookieAttrSep = ';'
    private static readonly StatusOk = 200
    private static readonly StatusUnauthorized = 401
    private static readonly StatusCreated = 201
    private static readonly PollTimeoutMs = 90000
    private static readonly PollIntervalMs = 1000
    private static readonly PassTag = 'PASS '
    private static readonly FailTag = 'FAIL '
    private static readonly DetailSep = ' -- '
    private static readonly OverallPass = 'OVERALL PASS'
    private static readonly OverallFail = 'OVERALL FAIL'
    private static readonly CrashPrefix = 'smoke crashed: '
    private static readonly TimeoutPrefix = 'timed out waiting for '
    private static readonly StatusWord = ' status='
    private static readonly MissingOpen = ' missing=['
    private static readonly MissingClose = '] admin='
    private static readonly Comma = ','
    private static readonly DataEvent = 'data'
    private static readonly EndEvent = 'end'
    private static readonly ErrorEvent = 'error'
    private static readonly Labels = {
        Gate401: 'control plane: unauthenticated request returns 401',
        Login: 'control plane: operator login returns 200 and a session cookie',
        CreateDev: 'dev-blank: create returns 201',
        RunningDev: 'dev-blank: reaches running',
        HealthDev: 'dev-blank: /healthz returns 200',
        StopDev: 'dev-blank: stop returns 200',
        StoppedDev: 'dev-blank: reaches stopped',
        StartDev: 'dev-blank: start returns 200',
        RestartedDev: 'dev-blank: running again after start',
        DeleteDev: 'dev-blank: delete returns 200',
        GoneDev: 'dev-blank: no longer listed',
        CreateDemo: 'demo-contoso: create returns 201',
        RunningDemo: 'demo-contoso: reaches running',
        HealthDemo: 'demo-contoso: /healthz returns 200',
        SeededDemo: 'demo-contoso: four demo principals plus admin seeded',
        DeleteDemo: 'demo-contoso: delete returns 200',
        GoneDemo: 'demo-contoso: no longer listed'
    }

    private failed = false
    private controlPort = 0
    private sessionCookie = ''

    public static async Main(): Promise<void>
    {
        const smoke = new ControlPlaneSmoke()
        const ok = await smoke.Run()
        console.log(ok ? ControlPlaneSmoke.OverallPass : ControlPlaneSmoke.OverallFail)
        process.exit(ok ? 0 : 1)
    }

    public async Run(): Promise<boolean>
    {
        const dataRoot = mkdtempSync(join(tmpdir(), ControlPlaneSmoke.TempPrefix))
        const staticRoot = join(dataRoot, ControlPlaneSmoke.StaticDir)
        mkdirSync(staticRoot, { recursive: true })
        const docker = new DockerEnvAdapter(new DockerEnv())
        const registry = new EnvironmentRegistry(join(dataRoot, ControlPlaneSmoke.RegistryFile), docker)
        await registry.Load()
        await registry.Reconcile()
        const allocator = new PortAllocator(ControlPlaneSmoke.EnvPortFloor, new NetPortProbe())
        const service = new EnvironmentService(registry, allocator, docker, new BundleBuilderAdapter(), new UserSeederAdapter(new UserSeeder()), dataRoot)
        const operator = await OperatorIdentity.Compose({
            identityRoot: join(dataRoot, ControlPlaneSmoke.IdentityDir),
            masterKeyFile: join(dataRoot, ControlPlaneSmoke.MasterKeyFile),
            operatorEmail: ControlPlaneSmoke.OperatorEmail,
            initialPassword: ControlPlaneSmoke.OperatorPassword
        })
        const host = new ControlPlaneHost(service, staticRoot, operator, false)
        try
        {
            await host.Listen(0, ControlPlaneSmoke.LoopbackHost)
            this.controlPort = host.Address().port
            if (await this.Authenticate())
            {
                await this.DevLifecycle()
                await this.DemoSeeded(dataRoot)
            }
        }
        catch (err)
        {
            this.failed = true
            console.log(ControlPlaneSmoke.CrashPrefix + (err instanceof Error ? err.message : String(err)))
        }
        finally
        {
            await this.Cleanup()
            await host.Close()
            rmSync(dataRoot, { recursive: true, force: true })
        }
        return !this.failed
    }

    /** Asserts the auth gate is live, then logs in and stores the session cookie; false when no session. */
    private async Authenticate(): Promise<boolean>
    {
        const gated = await this.Api(ControlPlaneSmoke.MethodGet, ControlPlaneSmoke.EnvironmentsPath)
        this.Expect(ControlPlaneSmoke.Labels.Gate401, gated.status === ControlPlaneSmoke.StatusUnauthorized, ControlPlaneSmoke.StatusWord + String(gated.status))
        const login = await this.Api(ControlPlaneSmoke.MethodPost, ControlPlaneSmoke.LoginPath, { email: ControlPlaneSmoke.OperatorEmail, password: ControlPlaneSmoke.OperatorPassword })
        const prefix = ControlPlaneSmoke.SessionCookieName + '='
        const pair = login.setCookie.map(c => c.split(ControlPlaneSmoke.CookieAttrSep)[0]).find(c => c.startsWith(prefix))
        this.Expect(ControlPlaneSmoke.Labels.Login, login.status === ControlPlaneSmoke.StatusOk && pair !== undefined, ControlPlaneSmoke.StatusWord + String(login.status))
        if (pair === undefined)
        {
            return false
        }
        this.sessionCookie = pair
        return true
    }

    /** Best-effort removal of both smoke environments so a rerun starts clean. */
    private async Cleanup(): Promise<void>
    {
        for (const name of [ControlPlaneSmoke.DevName, ControlPlaneSmoke.DemoName])
        {
            try
            {
                await this.Api(ControlPlaneSmoke.MethodDelete, this.EnvPath(name))
            }
            catch
            {
                // already gone or unreachable: ignore
            }
        }
    }

    private async DevLifecycle(): Promise<void>
    {
        const L = ControlPlaneSmoke.Labels
        const name = ControlPlaneSmoke.DevName
        const created = await this.Api(ControlPlaneSmoke.MethodPost, ControlPlaneSmoke.EnvironmentsPath, { name, template: Template.DevBlank })
        this.Expect(L.CreateDev, created.status === ControlPlaneSmoke.StatusCreated, ControlPlaneSmoke.StatusWord + String(created.status))
        const running = await this.WaitFor(name, EnvStatus.Running)
        this.Expect(L.RunningDev, running !== undefined)
        if (running === undefined)
        {
            return
        }
        await this.CheckHealth(L.HealthDev, running.hostPort)
        const stop = await this.Api(ControlPlaneSmoke.MethodPost, this.EnvPath(name) + ControlPlaneSmoke.StopAction)
        this.Expect(L.StopDev, stop.status === ControlPlaneSmoke.StatusOk, ControlPlaneSmoke.StatusWord + String(stop.status))
        this.Expect(L.StoppedDev, (await this.WaitFor(name, EnvStatus.Stopped)) !== undefined)
        const start = await this.Api(ControlPlaneSmoke.MethodPost, this.EnvPath(name) + ControlPlaneSmoke.StartAction)
        this.Expect(L.StartDev, start.status === ControlPlaneSmoke.StatusOk, ControlPlaneSmoke.StatusWord + String(start.status))
        this.Expect(L.RestartedDev, (await this.WaitFor(name, EnvStatus.Running)) !== undefined)
        const del = await this.Api(ControlPlaneSmoke.MethodDelete, this.EnvPath(name))
        this.Expect(L.DeleteDev, del.status === ControlPlaneSmoke.StatusOk, ControlPlaneSmoke.StatusWord + String(del.status))
        this.Expect(L.GoneDev, (await this.Find(name)) === undefined)
    }

    private async DemoSeeded(dataRoot: string): Promise<void>
    {
        const L = ControlPlaneSmoke.Labels
        const name = ControlPlaneSmoke.DemoName
        const created = await this.Api(ControlPlaneSmoke.MethodPost, ControlPlaneSmoke.EnvironmentsPath, { name, template: Template.DemoContoso })
        this.Expect(L.CreateDemo, created.status === ControlPlaneSmoke.StatusCreated, ControlPlaneSmoke.StatusWord + String(created.status))
        const running = await this.WaitFor(name, EnvStatus.Running)
        this.Expect(L.RunningDemo, running !== undefined)
        if (running === undefined)
        {
            return
        }
        await this.CheckHealth(L.HealthDemo, running.hostPort)
        await this.CheckSeeded(dataRoot, running.hostPort)
        const del = await this.Api(ControlPlaneSmoke.MethodDelete, this.EnvPath(name))
        this.Expect(L.DeleteDemo, del.status === ControlPlaneSmoke.StatusOk, ControlPlaneSmoke.StatusWord + String(del.status))
        this.Expect(L.GoneDemo, (await this.Find(name)) === undefined)
    }

    private async CheckSeeded(dataRoot: string, port: number): Promise<void>
    {
        const secretsPath = join(dataRoot, ControlPlaneSmoke.DemoName, ControlPlaneSmoke.SecretsFile)
        const secrets = JSON.parse(readFileSync(secretsPath, ControlPlaneSmoke.Utf8)) as Record<string, string>
        const adminPw = secrets[ControlPlaneSmoke.AdminPwKey]
        if (adminPw === undefined)
        {
            this.Expect(ControlPlaneSmoke.Labels.SeededDemo, false, ControlPlaneSmoke.AdminPwKey)
            return
        }
        const seeder = new UserSeeder()
        const token = await seeder.Login(ControlPlaneSmoke.HttpPrefix + String(port), ControlPlaneSmoke.DemoTenant, ControlPlaneSmoke.AdminEmail, adminPw)
        const conn = await seeder.Connect(ControlPlaneSmoke.WsPrefix + String(port), ControlPlaneSmoke.DemoTenant, token)
        try
        {
            const accounts = await conn.sendRequest(AdminProtocol.ListAccounts, undefined)
            const ids = new Set(accounts.map(a => a.principalId))
            const missing = ControlPlaneSmoke.DemoPrincipals.filter(p => !ids.has(p))
            const hasAdmin = accounts.some(a => a.email === ControlPlaneSmoke.AdminEmail)
            const detail = ControlPlaneSmoke.MissingOpen + missing.join(ControlPlaneSmoke.Comma) + ControlPlaneSmoke.MissingClose + String(hasAdmin)
            this.Expect(ControlPlaneSmoke.Labels.SeededDemo, missing.length === 0 && hasAdmin, detail)
        }
        finally
        {
            conn.dispose()
        }
    }

    private async CheckHealth(label: string, hostPort: number): Promise<void>
    {
        const res = await this.Http(ControlPlaneSmoke.MethodGet, hostPort, ControlPlaneSmoke.HealthPath)
        this.Expect(label, res.status === ControlPlaneSmoke.StatusOk, ControlPlaneSmoke.StatusWord + String(res.status))
    }

    private EnvPath(name: string): string
    {
        return ControlPlaneSmoke.EnvironmentsPath + ControlPlaneSmoke.PathSep + encodeURIComponent(name)
    }

    private async Find(name: string): Promise<EnvironmentDto | undefined>
    {
        const res = await this.Api(ControlPlaneSmoke.MethodGet, ControlPlaneSmoke.EnvironmentsPath)
        return (res.json as EnvironmentDto[]).find(e => e.name === name)
    }

    /** Polls the list until the named environment has the wanted status; undefined on timeout. */
    private async WaitFor(name: string, status: EnvStatus): Promise<EnvironmentDto | undefined>
    {
        const deadline = Date.now() + ControlPlaneSmoke.PollTimeoutMs
        while (Date.now() < deadline)
        {
            const env = await this.Find(name)
            if (env !== undefined && env.status === status)
            {
                return env
            }
            await new Promise<void>(resolve => setTimeout(resolve, ControlPlaneSmoke.PollIntervalMs))
        }
        console.log(ControlPlaneSmoke.TimeoutPrefix + name + ControlPlaneSmoke.StatusWord + status)
        return undefined
    }

    private Api(method: string, path: string, body?: unknown): Promise<HttpResult>
    {
        const extra: Record<string, string> = {}
        if (this.sessionCookie !== '')
        {
            extra[ControlPlaneSmoke.CookieHeader] = this.sessionCookie
        }
        return this.Http(method, this.controlPort, path, body, extra)
    }

    private Http(method: string, port: number, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<HttpResult>
    {
        return new Promise<HttpResult>((resolve, reject) =>
        {
            const payload = body === undefined ? undefined : JSON.stringify(body)
            const headers: Record<string, string> = { ...extraHeaders }
            if (payload !== undefined)
            {
                headers[ControlPlaneSmoke.ContentTypeHeader] = ControlPlaneSmoke.JsonContentType
            }
            const req = request({ host: ControlPlaneSmoke.LoopbackHost, port, path, method, headers }, res =>
            {
                const chunks: Buffer[] = []
                res.on(ControlPlaneSmoke.DataEvent, (c: Buffer) => chunks.push(c))
                res.on(ControlPlaneSmoke.EndEvent, () =>
                {
                    const text = Buffer.concat(chunks).toString(ControlPlaneSmoke.Utf8)
                    let json: unknown = undefined
                    try
                    {
                        json = text === '' ? undefined : JSON.parse(text)
                    }
                    catch
                    {
                        json = text
                    }
                    resolve({ status: res.statusCode ?? 0, json, setCookie: res.headers[ControlPlaneSmoke.SetCookieHeader] ?? [] })
                })
            })
            req.on(ControlPlaneSmoke.ErrorEvent, reject)
            if (payload !== undefined)
            {
                req.write(payload)
            }
            req.end()
        })
    }

    private Expect(label: string, ok: boolean, detail: string = ''): void
    {
        if (!ok)
        {
            this.failed = true
        }
        const suffix = ok || detail === '' ? '' : ControlPlaneSmoke.DetailSep + detail
        console.log((ok ? ControlPlaneSmoke.PassTag : ControlPlaneSmoke.FailTag) + label + suffix)
    }

    /** True when this module is the process entry point (not when imported). */
    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
    }
}

if (ControlPlaneSmoke.IsEntryPoint())
{
    await ControlPlaneSmoke.Main()
}
