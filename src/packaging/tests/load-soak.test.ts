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

const soak = process.env.PRAGMATIC_SOAK

class Soak
{
    public static readonly Tenant = 't1'
    public static readonly KeyEnv = 'PS_SOAK_KEY'
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
    public static readonly SettleMs = 100
    public static readonly HttpTimeoutMs = 5000

    public static readonly OptInSkip = 'set PRAGMATIC_SOAK=1 to run'
    public static readonly WindowsSkip = 'POSIX-only: Windows process.kill cannot deliver a catchable SIGTERM for graceful drain'

    private static readonly ReadyzPath = '/readyz'
    private static readonly MetricsPath = '/metrics'
    private static readonly LocalHost = '127.0.0.1'
    private static readonly SigTerm = 'SIGTERM'
    private static readonly SigKill = 'SIGKILL'
    private static readonly TsxImport = 'tsx'
    private static readonly ImportFlag = '--import'
    private static readonly HttpTimeoutMessage = 'http timeout'

    public static OptIn(): string | false
    {
        return soak === undefined ? Soak.OptInSkip : false
    }

    public static PosixOnly(): string | false
    {
        if (soak === undefined)
        {
            return Soak.OptInSkip
        }
        return process.platform === 'win32' ? Soak.WindowsSkip : false
    }

    public static Provisioning(): InMemoryTenantProvisioning
    {
        return new InMemoryTenantProvisioning(new Map<string, TenantProvisioning>([[Soak.Tenant, { displayName: 'T1' }]]))
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

    public static Readyz(port: number): Promise<number>
    {
        return new Promise<number>((resolve, reject) =>
        {
            const req = request({ host: Soak.LocalHost, port, path: Soak.ReadyzPath, method: 'GET' }, res =>
            {
                res.resume()
                resolve(res.statusCode ?? 0)
            })
            req.setTimeout(Soak.HttpTimeoutMs, () => req.destroy(new Error(Soak.HttpTimeoutMessage)))
            req.on('error', reject)
            req.end()
        })
    }

    public static Sleep(ms: number): Promise<void>
    {
        return new Promise<void>(resolve => setTimeout(resolve, ms))
    }

    public static Bin(): string
    {
        return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'server-main.ts')
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

test('soak: concurrent WS+HTTP load stays within thresholds, leaks no connections, and metrics+audit fire (Review Focus 5)', { skip: Soak.OptIn() }, async () =>
{
    const baseDir = mkdtempSync(join(tmpdir(), 'ps-soak-'))
    mkdirSync(join(baseDir, Soak.Tenant), { recursive: true })
    cpSync(Soak.Fixture(), join(baseDir, Soak.Tenant, 'solution'), { recursive: true })
    const keyPath = join(baseDir, 'key')
    writeFileSync(keyPath, randomBytes(32))
    const auditFile = join(baseDir, 'audit.log')
    const observability = Observability.Start({ role: ObservabilityRole.Host, serviceName: 'pragmatic-server', metricsPort: Soak.MetricsPort })
    let host: PragmaticServerHost | undefined
    try
    {
        const audit = new FileAccessAuditSink(auditFile, undefined, StructuredLogger.ToSink(() => {}))
        host = await PragmaticServerHost.StartAsync({ host: '127.0.0.1', port: 0, baseDir, masterKey: { keyFilePath: keyPath }, provisioning: Soak.Provisioning(), observability, audit, drainTimeoutMs: 25000 })
        const addr = host.Address()
        const token = await Soak.TokenFor(host)
        const heapBefore = process.memoryUsage().heapUsed
        const latencies: number[] = []
        // One serial open up front: concurrent same-tenant OpenSolution calls leave an engine content watcher armed
        // after teardown (upstream todl race), which would keep the test process alive. The load itself stays concurrent.
        const primer = await PragmaticClient.ConnectAsync(`ws://${addr.host}:${addr.port}/?tenant=${Soak.Tenant}`, { bearerToken: token })
        try
        {
            await primer.OpenSolution(join(baseDir, Soak.Tenant, 'solution'))
        }
        finally
        {
            await primer.DisposeAsync()
        }
        const workers = Array.from({ length: Soak.Concurrency }, async () =>
        {
            const client = await PragmaticClient.ConnectAsync(`ws://${addr.host}:${addr.port}/?tenant=${Soak.Tenant}`, { bearerToken: token })
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
        await Soak.Sleep(Soak.SettleMs)

        assert.equal(latencies.length, Soak.Concurrency * Soak.RequestsPerClient)
        assert.ok(Soak.Percentile(latencies, 95) < Soak.P95CeilingMs, `p95 ${Soak.Percentile(latencies, 95)}ms`)
        assert.equal(host.HandlerCountForTest(), 0, 'no connection leak')
        assert.ok(process.memoryUsage().heapUsed - heapBefore < Soak.HeapGrowthCeilingBytes, 'heap growth bounded')

        const scrape = await Soak.Scrape(Soak.MetricsPort)
        assert.match(scrape, /requests_total/)
        assert.ok(existsSync(auditFile) && readFileSync(auditFile, 'utf8').trim().length > 0, 'audit fired under load')
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

test('mid-load SIGTERM drains cleanly and the child process exits 0 within the grace period (Review Focus 1, 5)', { skip: Soak.PosixOnly() }, async () =>
{
    const baseDir = mkdtempSync(join(tmpdir(), 'ps-soak-sig-'))
    const tenantsFile = join(baseDir, 'tenants.json')
    writeFileSync(tenantsFile, JSON.stringify({ tenants: { [Soak.Tenant]: { displayName: 'T1' } } }))
    const env = {
        ...process.env,
        PRAGMATIC_HOST: '127.0.0.1',
        PRAGMATIC_PORT: String(Soak.ChildPort),
        PRAGMATIC_BASE_DIR: baseDir,
        PRAGMATIC_TENANTS_FILE: tenantsFile,
        PRAGMATIC_MASTER_KEY_B64_ENV: Soak.KeyEnv,
        [Soak.KeyEnv]: randomBytes(32).toString('base64'),
        PRAGMATIC_METRICS_PORT: String(Soak.ChildMetricsPort),
        PRAGMATIC_DRAIN_TIMEOUT_MS: '3000',
    }
    const child = Soak.SpawnServer(env)
    const exited = new Promise<number>(resolve => child.on('exit', code => resolve(code ?? -1)))
    try
    {
        let ready = false
        for (let i = 0; i < Soak.ReadyPolls; i += 1)
        {
            await Soak.Sleep(Soak.ReadyPollMs)
            const status = await Soak.Readyz(Soak.ChildPort).catch(() => 0)
            if (status === 200)
            {
                ready = true
                break
            }
        }
        assert.ok(ready, 'child became ready')
        Soak.Term(child)
        let sawUnavailable = false
        for (let i = 0; i < Soak.UnavailablePolls; i += 1)
        {
            const status = await Soak.Readyz(Soak.ChildPort).catch(() => 503)
            if (status === 503)
            {
                sawUnavailable = true
                break
            }
            await Soak.Sleep(Soak.UnavailablePollMs)
        }
        assert.ok(sawUnavailable, '/readyz flipped to 503 on SIGTERM')
        const code = await Promise.race([exited, Soak.Sleep(Soak.ExitGraceMs).then(() => -2)])
        assert.equal(code, 0, 'child exited 0 within the grace period')
    }
    finally
    {
        if (child.exitCode === null)
        {
            Soak.Kill(child)
        }
        rmSync(baseDir, { recursive: true, force: true })
    }
})
