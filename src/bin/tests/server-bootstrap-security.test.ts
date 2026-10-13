import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeploymentMode } from '../../platform/deployment-mode.js'
import { AuditSinkKind } from '../../config/audit-sink-kind.js'
import { ServerBootstrap } from '../server-bootstrap.js'
import { NullAccessAuditSink, AuditSurface, AuditOutcome } from '../../host/access-audit.js'
import { FileAccessAuditSink } from '../../host/file-access-audit-sink.js'
import { SqlAuditAccessSink } from '../../host/sql-access-audit-sink.js'
import { RateLimitScope } from '../../host/rate-limiter.js'
import type { ServerConfig } from '../../config/server-config.js'
import type { AuditEvent, IAuditSink } from '@pragmatic-tech-ai/todl-identity'
import { NullLogger } from '../../observability/logger.js'

class CapturingStore implements IAuditSink
{
    public readonly Events: AuditEvent[] = []

    public Record(event: AuditEvent): Promise<void>
    {
        this.Events.push(event)
        return Promise.resolve()
    }
}

class SecurityFixture
{
    public static BaseConfig(): ServerConfig
    {
        return { host: '0.0.0.0', port: 8080, baseDir: '/d', masterKey: { keyFilePath: '/k' }, deploymentMode: DeploymentMode.Local }
    }

    public static Tenant(): { scope: RateLimitScope; tenant: string; key: string }
    {
        return { scope: RateLimitScope.Tenant, tenant: 't1', key: 't1' }
    }

    public static Context(): { surface: AuditSurface; tenant: string; methodOrPath: string }
    {
        return { surface: AuditSurface.Upgrade, tenant: 't1', methodOrPath: 'ws' }
    }
}

test('AuditSink returns a NullAccessAuditSink when unconfigured', () =>
{
    assert.ok(ServerBootstrap.AuditSink(SecurityFixture.BaseConfig(), new NullLogger()) instanceof NullAccessAuditSink)
})

test('AuditSink=file builds a FileAccessAuditSink that writes to the path', async () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'ps-bs-'))
    const path = join(dir, 'a.log')
    try
    {
        const sink = ServerBootstrap.AuditSink({ ...SecurityFixture.BaseConfig(), auditSink: AuditSinkKind.File, auditFile: path }, new NullLogger())
        assert.ok(sink instanceof FileAccessAuditSink)
        await sink.Record({ Timestamp: new Date(), TenantId: 't1', Surface: AuditSurface.Rpc, MethodOrPath: 'm', Outcome: AuditOutcome.Allow })
        assert.ok(readFileSync(path, 'utf8').includes('"tenant":"t1"'))
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('AuditSink=sql with a cloud store builds a SqlAuditAccessSink; without one it fails closed', async () =>
{
    const store = new CapturingStore()
    const config = { ...SecurityFixture.BaseConfig(), auditSink: AuditSinkKind.Sql }
    const sink = ServerBootstrap.AuditSink(config, new NullLogger(), undefined, store)
    assert.ok(sink instanceof SqlAuditAccessSink)
    await sink.Record({ Timestamp: new Date(), TenantId: 't1', Surface: AuditSurface.Rpc, MethodOrPath: 'm', Outcome: AuditOutcome.Allow })
    assert.equal(store.Events.length, 1)
    assert.throws(() => ServerBootstrap.AuditSink(config, new NullLogger()), /cloud audit store/)
})

test('RateLimit returns a pass-through guard when unconfigured and an enforcing guard when configured', () =>
{
    const disabled = ServerBootstrap.RateLimit(SecurityFixture.BaseConfig(), new NullAccessAuditSink())
    for (let i = 0; i < 20; i++)
    {
        assert.equal(disabled.Check(SecurityFixture.Tenant(), SecurityFixture.Context()).Allowed, true)
    }
    const enforcing = ServerBootstrap.RateLimit({ ...SecurityFixture.BaseConfig(), rateLimit: { perTenant: { Rps: 0.001, Burst: 1 } } }, new NullAccessAuditSink())
    assert.equal(enforcing.Check(SecurityFixture.Tenant(), SecurityFixture.Context()).Allowed, true)
    assert.equal(enforcing.Check(SecurityFixture.Tenant(), SecurityFixture.Context()).Allowed, false)
})

test('the startup line reports audit + ratelimit tokens and never the audit path', () =>
{
    const line = ServerBootstrap.StartupLine({ ...SecurityFixture.BaseConfig(), auditSink: AuditSinkKind.File, auditFile: '/secret/path/audit.log', rateLimit: { perTenant: { Rps: 1, Burst: 1 } } }, 1)
    assert.ok(line.includes('audit=file'))
    assert.ok(line.includes('ratelimit=on'))
    assert.equal(line.includes('/secret/path/audit.log'), false)
    const off = ServerBootstrap.StartupLine(SecurityFixture.BaseConfig(), 1)
    assert.ok(off.includes('audit=none'))
    assert.ok(off.includes('ratelimit=off'))
})

test('ComposeOptions threads the sink and guard through', () =>
{
    const audit = new NullAccessAuditSink()
    const guard = ServerBootstrap.RateLimit(SecurityFixture.BaseConfig(), audit)
    const options = ServerBootstrap.ComposeOptions(SecurityFixture.BaseConfig(), {} as never, undefined, undefined, undefined, undefined, audit, guard)
    assert.equal(options.audit, audit)
    assert.equal(options.rateLimit, guard)
})

test('AuditSink=file without a path fails closed instead of returning a null sink', () =>
{
    assert.throws(() => ServerBootstrap.AuditSink({ ...SecurityFixture.BaseConfig(), auditSink: AuditSinkKind.File }, new NullLogger()), /audit file path required/)
    assert.throws(() => ServerBootstrap.AuditSink({ ...SecurityFixture.BaseConfig(), auditSink: AuditSinkKind.File, auditFile: '' }, new NullLogger()), /audit file path required/)
})
