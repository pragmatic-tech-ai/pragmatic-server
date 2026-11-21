import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, cpSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { PragmaticServerHost } from '../pragmatic-server-host.js'
import { InMemoryEnvironmentProvisioning } from '../../environments/environment-registry.js'
import type { EnvironmentProvisioning } from '../../environments/environment-provisioning.js'
import { RateLimitGuard, TokenBucketRateLimiter, AuditSurface, AuditOutcome, type IAccessAuditSink, type AccessAuditEvent } from '@pragmatic-tech-ai/pragmatic-env-cluster'

class CapturingSink implements IAccessAuditSink
{
    public Drain(): Promise<void> { return Promise.resolve() }
    public readonly Events: AccessAuditEvent[] = []

    public Record(event: AccessAuditEvent): Promise<void>
    {
        this.Events.push(event)
        return Promise.resolve()
    }
}

class UpgradeProbe
{
    public static Status(url: string): Promise<{ status: number, retryAfter: string | undefined }>
    {
        return new Promise((resolve, reject) =>
        {
            const ws = new WebSocket(url)
            ws.on('unexpected-response', (_req, res) =>
            {
                const header = res.headers['retry-after']
                resolve({ status: res.statusCode ?? 0, retryAfter: Array.isArray(header) ? header[0] : header })
                ws.terminate()
            })
            ws.on('open', () =>
            {
                resolve({ status: 101, retryAfter: undefined })
                ws.terminate()
            })
            ws.on('error', err => reject(err))
        })
    }
}

test('a per-environment upgrade breach returns 429 with Retry-After and audits a RateLimited Upgrade event', async () =>
{
    const baseDir = mkdtempSync(join(tmpdir(), 'ps-base-'))
    mkdirSync(join(baseDir, 't1'), { recursive: true })
    cpSync(join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution'), join(baseDir, 't1', 'solution'), { recursive: true })
    const keyEnv = 'PS_RL_KEY'
    process.env[keyEnv] = randomBytes(32).toString('base64')
    const sink = new CapturingSink()
    const guard = new RateLimitGuard(new TokenBucketRateLimiter({ perEnvironment: { Rps: 0.001, Burst: 1 } }), sink)
    const entries = new Map<string, EnvironmentProvisioning>([['t1', { displayName: 'Environment One' }]])
    const host = await PragmaticServerHost.StartAsync({ host: '127.0.0.1', port: 0, baseDir, masterKey: { base64Env: keyEnv }, provisioning: new InMemoryEnvironmentProvisioning(entries), rateLimit: guard })
    const base = `ws://${host.Address().host}:${host.Address().port}/?environment=t1`
    try
    {
        const first = await UpgradeProbe.Status(base)
        assert.ok(first.status === 401 || first.status === 101)
        const second = await UpgradeProbe.Status(base)
        assert.equal(second.status, 429)
        assert.ok(Number(second.retryAfter) >= 1)
        const limited = sink.Events.filter(e => e.Outcome === AuditOutcome.RateLimited)
        assert.equal(limited.length, 1)
        assert.equal(limited[0]!.Surface, AuditSurface.Upgrade)
        assert.equal(limited[0]!.EnvironmentId, 't1')
    }
    finally
    {
        await host.DisposeAsync()
        rmSync(baseDir, { recursive: true, force: true })
        delete process.env[keyEnv]
    }
})
