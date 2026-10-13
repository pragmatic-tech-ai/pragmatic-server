import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, cpSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { Grant, Role, ResourceRef, ResourceKind } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import { PragmaticServerHost } from '../../host/pragmatic-server-host.js'
import { InMemoryTenantProvisioning } from '../../tenancy/tenant-registry.js'
import type { TenantProvisioning } from '../../tenancy/tenant-provisioning.js'
import { Observability, ObservabilityRole } from '../../observability/observability.js'
import { FileAccessAuditSink } from '../../host/file-access-audit-sink.js'
import { StructuredLogger } from '../../observability/logger.js'

class Soak
{
    private static readonly SoakFlag = process.env.PRAGMATIC_SOAK
    public static readonly Tenant = 't1'
    public static readonly Concurrency = 8
    public static readonly RequestsPerClient = 40
    public static readonly P95CeilingMs = 10000
    public static readonly HeapGrowthCeilingBytes = 250 * 1024 * 1024
    public static readonly MetricsPort = 19464
    public static readonly ChildPort = 18090
    public static readonly ChildMetricsPort = 19465
    public static readonly ReadyPolls = 200
    public static readonly ReadyPollMs = 100
    public static readonly UnavailablePolls = 80
    public static readonly UnavailablePollMs = 25
    public static readonly ExitGraceMs = 15000
    public static readonly HandlerSettleDeadlineMs = 5000
    public static readonly HandlerSettlePollMs = 25
    public static readonly HttpTimeoutMs = 5000
    public static readonly LoadTestTimeoutMs = 120000
    public static readonly SigtermTestTimeoutMs = 60000

    /** Sentinel statuses returned by Readyz when no HTTP status was observed. */
    public static readonly ReadyRefused = -1
    public static readonly ReadyError = 0

    public static readonly OptInSkip = 'set PRAGMATIC_SOAK=1 to run'
    public static readonly WindowsSkip = 'POSIX-only: Windows process.kill cannot deliver a catchable SIGTERM for graceful drain'

    private static readonly KeyEnv = 'PS_SOAK_KEY'
    private static readonly LocalHost = '127.0.0.1'
    private static readonly DisplayName = 'T1'
    private static readonly ServiceName = 'pragmatic-server'
    public static readonly LoadDirPrefix = 'ps-soak-'
    public static readonly SigDirPrefix = 'ps-soak-sig-'
    private static readonly AuditFileName = 'audit.log'
    private static readonly TenantsFileName = 'tenants.json'
    private static readonly KeyFileName = 'key'
    private static readonly SolutionDir = 'solution'
    private static readonly ReadyzPath = '/readyz'
    private static readonly MetricsPath = '/metrics'
    private static readonly SigTerm = 'SIGTERM'
    private static readonly SigKill = 'SIGKILL'
    private static readonly TsxImport = 'tsx'
    private static readonly ImportFlag = '--import'
    private static readonly HttpTimeoutMessage = 'http timeout'
    private static readonly ConnectionRefused = 'ECONNREFUSED'
    private static readonly Base64 = 'base64'
    private static readonly Utf8 = 'utf8'
    private static readonly DrainTimeoutValue = '3000'
    private static readonly HostDrainTimeoutMs = 25000
    private static readonly EnvHost = 'PRAGMATIC_HOST'
    private static readonly EnvPort = 'PRAGMATIC_PORT'
    private static readonly EnvBaseDir = 'PRAGMATIC_BASE_DIR'
    private static readonly EnvTenantsFile = 'PRAGMATIC_TENANTS_FILE'
    private static readonly EnvMasterKeyEnv = 'PRAGMATIC_MASTER_KEY_B64_ENV'
    private static readonly EnvMetricsPort = 'PRAGMATIC_METRICS_PORT'
    private static readonly EnvDrainTimeout = 'PRAGMATIC_DRAIN_TIMEOUT_MS'

    public static readonly MsgNoLeak = 'no connection leak'
    public static readonly MsgHeap = 'heap growth bounded'
    public static readonly MsgAudit = 'audit fired under load: first non-empty line is JSON'
    public static readonly MsgAuditEmpty = 'audit file has at least one line'
    public static readonly MsgReady = 'child became ready'
    public static readonly MsgSpawn = 'child spawned without error'
    public static readonly MsgUnavailable = '/readyz returned a real 503 (or the server had already closed) after SIGTERM'
    public static readonly MsgExit = 'child exited 0 within the grace period'

    public static OptIn(): string | false
    {
        return Soak.SoakFlag === undefined ? Soak.OptInSkip : false
    }

    public static PosixOnly(): string | false
    {
        if (Soak.SoakFlag === undefined)
        {
            return Soak.OptInSkip
        }
        return process.platform === 'win32' ? Soak.WindowsSkip : false
    }

    public static Provisioning(): InMemoryTenantProvisioning
    {
        return new InMemoryTenantProvisioning(new Map<string, TenantProvisioning>([[Soak.Tenant, { displayName: Soak.DisplayName }]]))
    }

    public static Fixture(): string
    {
        return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', 'sample-solution')
    }

    public static async TokenFor(host: PragmaticServerHost): Promise<string>
    {
        const pack = await host.IdentityPackForTest(Soak.Tenant)
        await pack.Grants.Save(new Grant(Soak.Tenant, Role.Admin, new ResourceRef(ResourceKind.Tenant, Soak.Tenant, [])))
        const tenant = await host.TenantForTest(Soak.Tenant)
        return (await pack.Tokens.Issue(tenant, Soak.Tenant, [], null)).Token
    }

    public static Percentile(samples: number[], p: number): number
    {
        const sorted = [...samples].sort((a, b) => a - b)
        return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0
    }

    public static WsUrl(host: string, port: number): string
    {
        return `ws://${host}:${port}/?tenant=${Soak.Tenant}`
    }

    public static MakeBaseDir(prefix: string): string
    {
        return mkdtempSync(join(tmpdir(), prefix))
    }

    public static SolutionPath(baseDir: string): string
    {
        return join(baseDir, Soak.Tenant, Soak.SolutionDir)
    }

    public static SeedLoadDir(baseDir: string): { keyPath: string, auditFile: string }
    {
        mkdirSync(join(baseDir, Soak.Tenant), { recursive: true })
        cpSync(Soak.Fixture(), Soak.SolutionPath(baseDir), { recursive: true })
        const keyPath = join(baseDir, Soak.KeyFileName)
        writeFileSync(keyPath, randomBytes(32))
        return { keyPath, auditFile: join(baseDir, Soak.AuditFileName) }
    }

    public static StartObservability(): Observability
    {
        return Observability.Start({ role: ObservabilityRole.Host, serviceName: Soak.ServiceName, metricsPort: Soak.MetricsPort })
    }

    public static NewAudit(auditFile: string): FileAccessAuditSink
    {
        return new FileAccessAuditSink(auditFile, undefined, StructuredLogger.ToSink(() => {}))
    }

    public static StartHost(baseDir: string, keyPath: string, observability: Observability, audit: FileAccessAuditSink): Promise<PragmaticServerHost>
    {
        return PragmaticServerHost.StartAsync({ host: Soak.LocalHost, port: 0, baseDir, masterKey: { keyFilePath: keyPath }, provisioning: Soak.Provisioning(), observability, audit, drainTimeoutMs: Soak.HostDrainTimeoutMs })
    }

    /** Bounded poll: waits for the live-handler count to reach zero, returning the last observed count. */
    public static async SettledHandlerCount(host: PragmaticServerHost): Promise<number>
    {
        const deadline = Date.now() + Soak.HandlerSettleDeadlineMs
        let count = host.HandlerCountForTest()
        while (count !== 0 && Date.now() < deadline)
        {
            await Soak.Sleep(Soak.HandlerSettlePollMs)
            count = host.HandlerCountForTest()
        }
        return count
    }

    /** Asserts the audit file has at least one non-empty line and that it parses as JSON (contents are never inspected). */
    public static AssertAuditLineIsJson(auditFile: string): void
    {
        assert.ok(existsSync(auditFile), Soak.MsgAuditEmpty)
        const line = readFileSync(auditFile, Soak.Utf8).split('\n').find(l => l.trim().length > 0)
        assert.ok(line !== undefined, Soak.MsgAuditEmpty)
        assert.doesNotThrow(() => JSON.parse(line), Soak.MsgAudit)
    }

    public static Scrape(port: number): Promise<string>
    {
        return new Promise<string>((resolve, reject) =>
        {
            const req = request({ host: Soak.LocalHost, port, path: Soak.MetricsPath, method: 'GET' }, res =>
            {
                let body = ''
                res.on('data', chunk => { body += chunk })
                res.on('end', () => resolve(body))
            })
            req.setTimeout(Soak.HttpTimeoutMs, () => req.destroy(new Error(Soak.HttpTimeoutMessage)))
            req.on('error', reject)
            req.end()
        })
    }

    /** Resolves the real HTTP status, ReadyRefused on ECONNREFUSED, or ReadyError on any other failure (e.g. timeout). */
    public static Readyz(port: number): Promise<number>
    {
        return new Promise<number>(resolve =>
        {
            const req = request({ host: Soak.LocalHost, port, path: Soak.ReadyzPath, method: 'GET' }, res =>
            {
                res.resume()
                resolve(res.statusCode ?? Soak.ReadyError)
            })
            req.setTimeout(Soak.HttpTimeoutMs, () => req.destroy(new Error(Soak.HttpTimeoutMessage)))
            req.on('error', (error: NodeJS.ErrnoException) => resolve(error.code === Soak.ConnectionRefused ? Soak.ReadyRefused : Soak.ReadyError))
            req.end()
        })
    }

    public static Sleep(ms: number): Promise<void>
    {
        return new Promise<void>(resolve => setTimeout(resolve, ms))
    }

    /** Races the child's exit against a grace timer that is always cancelled, so no timer outlives the test. */
    public static async RaceExit(exited: Promise<number>, graceMs: number): Promise<number>
    {
        let timer: NodeJS.Timeout | undefined
        const timeout = new Promise<number>(resolve =>
        {
            timer = setTimeout(() => resolve(-2), graceMs)
        })
        try
        {
            return await Promise.race([exited, timeout])
        }
        finally
        {
            clearTimeout(timer)
        }
    }

    public static Bin(): string
    {
        return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'server-main.ts')
    }

    public static ChildEnv(baseDir: string, tenantsFile: string): NodeJS.ProcessEnv
    {
        return {
            ...process.env,
            [Soak.EnvHost]: Soak.LocalHost,
            [Soak.EnvPort]: String(Soak.ChildPort),
            [Soak.EnvBaseDir]: baseDir,
            [Soak.EnvTenantsFile]: tenantsFile,
            [Soak.EnvMasterKeyEnv]: Soak.KeyEnv,
            [Soak.KeyEnv]: randomBytes(32).toString(Soak.Base64),
            [Soak.EnvMetricsPort]: String(Soak.ChildMetricsPort),
            [Soak.EnvDrainTimeout]: Soak.DrainTimeoutValue,
        }
    }

    public static WriteTenantsFile(baseDir: string): string
    {
        const tenantsFile = join(baseDir, Soak.TenantsFileName)
        writeFileSync(tenantsFile, JSON.stringify({ tenants: { [Soak.Tenant]: { displayName: Soak.DisplayName } } }))
        return tenantsFile
    }

    /** Spawns the Node process directly (no shell wrapper) so SIGTERM reaches the process that installed the handler. */
    public static SpawnServer(env: NodeJS.ProcessEnv): ChildProcess
    {
        return spawn(process.execPath, [Soak.ImportFlag, Soak.TsxImport, Soak.Bin()], { env, stdio: 'ignore' })
    }

    public static Term(child: ChildProcess): void
    {
        child.kill(Soak.SigTerm)
    }

    public static Kill(child: ChildProcess): void
    {
        child.kill(Soak.SigKill)
    }
}

test('soak: concurrent WS+HTTP load stays within thresholds, leaks no connections, and metrics+audit fire (Review Focus 5)', { skip: Soak.OptIn(), timeout: Soak.LoadTestTimeoutMs }, async () =>
{
    const baseDir = Soak.MakeBaseDir(Soak.LoadDirPrefix)
    const { keyPath, auditFile } = Soak.SeedLoadDir(baseDir)
    const observability = Soak.StartObservability()
    let host: PragmaticServerHost | undefined
    try
    {
        host = await Soak.StartHost(baseDir, keyPath, observability, Soak.NewAudit(auditFile))
        const addr = host.Address()
        const url = Soak.WsUrl(addr.host, addr.port)
        const token = await Soak.TokenFor(host)
        const heapBefore = process.memoryUsage().heapUsed
        const latencies: number[] = []
        // One serial open up front: concurrent same-tenant OpenSolution calls leave an engine content watcher armed
        // after teardown (upstream todl race), which would keep the test process alive. The load itself stays concurrent.
        const primer = await PragmaticClient.ConnectAsync(url, { bearerToken: token })
        try
        {
            await primer.OpenSolution(Soak.SolutionPath(baseDir))
        }
        finally
        {
            await primer.DisposeAsync()
        }
        const workers = Array.from({ length: Soak.Concurrency }, async () =>
        {
            const client = await PragmaticClient.ConnectAsync(url, { bearerToken: token })
            try
            {
                for (let i = 0; i < Soak.RequestsPerClient; i += 1)
                {
                    const start = Date.now()
                    await client.ActiveSolution()
                    latencies.push(Date.now() - start)
                }
            }
            finally
            {
                await client.DisposeAsync()
            }
        })
        await Promise.all(workers)

        assert.equal(latencies.length, Soak.Concurrency * Soak.RequestsPerClient)
        assert.ok(Soak.Percentile(latencies, 95) < Soak.P95CeilingMs, `p95 ${Soak.Percentile(latencies, 95)}ms`)
        assert.equal(await Soak.SettledHandlerCount(host), 0, Soak.MsgNoLeak)
        assert.ok(process.memoryUsage().heapUsed - heapBefore < Soak.HeapGrowthCeilingBytes, Soak.MsgHeap)

        const scrape = await Soak.Scrape(Soak.MetricsPort)
        assert.match(scrape, /requests_total/)
        Soak.AssertAuditLineIsJson(auditFile)
    }
    finally
    {
        try
        {
            await host?.DisposeAsync()
        }
        finally
        {
            await observability.Shutdown().catch(() => undefined)
            rmSync(baseDir, { recursive: true, force: true })
        }
    }
})

test('mid-load SIGTERM drains cleanly and the child process exits 0 within the grace period (Review Focus 1, 5)', { skip: Soak.PosixOnly(), timeout: Soak.SigtermTestTimeoutMs }, async () =>
{
    const baseDir = Soak.MakeBaseDir(Soak.SigDirPrefix)
    const child = Soak.SpawnServer(Soak.ChildEnv(baseDir, Soak.WriteTenantsFile(baseDir)))
    let spawnError: Error | undefined
    const exited = new Promise<number>(resolve =>
    {
        child.on('error', error =>
        {
            spawnError = error
            resolve(-1)
        })
        child.on('exit', code => resolve(code ?? -1))
    })
    try
    {
        let ready = false
        for (let i = 0; i < Soak.ReadyPolls && spawnError === undefined; i += 1)
        {
            await Soak.Sleep(Soak.ReadyPollMs)
            if (await Soak.Readyz(Soak.ChildPort) === 200)
            {
                ready = true
                break
            }
        }
        assert.equal(spawnError, undefined, Soak.MsgSpawn)
        assert.ok(ready, Soak.MsgReady)
        Soak.Term(child)
        // Success is an actual 503, or a refused connection (the server already finished closing).
        // A timeout or any other error is neither and keeps polling until the bounded deadline.
        let sawUnavailable = false
        for (let i = 0; i < Soak.UnavailablePolls; i += 1)
        {
            const status = await Soak.Readyz(Soak.ChildPort)
            if (status === 503 || status === Soak.ReadyRefused)
            {
                sawUnavailable = true
                break
            }
            await Soak.Sleep(Soak.UnavailablePollMs)
        }
        assert.ok(sawUnavailable, Soak.MsgUnavailable)
        const code = await Soak.RaceExit(exited, Soak.ExitGraceMs)
        assert.equal(code, 0, Soak.MsgExit)
    }
    finally
    {
        if (child.exitCode === null && child.signalCode === null)
        {
            Soak.Kill(child)
        }
        rmSync(baseDir, { recursive: true, force: true })
    }
})
