import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DeploymentMode, AuditSinkKind, NullAccessAuditSink, type ServerConfig, HostBootstrap } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import { ServerBootstrap } from '../server-bootstrap.js'

class SecurityFixture
{
    public static BaseConfig(): ServerConfig
    {
        return { host: '0.0.0.0', port: 8080, baseDir: '/d', masterKey: { keyFilePath: '/k' }, deploymentMode: DeploymentMode.Local }
    }
}

test('the startup line reports audit + ratelimit tokens and never the audit path', () =>
{
    const line = ServerBootstrap.StartupLine({ ...SecurityFixture.BaseConfig(), auditSink: AuditSinkKind.File, auditFile: '/secret/path/audit.log', rateLimit: { perEnvironment: { Rps: 1, Burst: 1 } } }, 1)
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
    const guard = HostBootstrap.RateLimit(SecurityFixture.BaseConfig(), audit)
    const options = ServerBootstrap.ComposeOptions(SecurityFixture.BaseConfig(), {} as never, undefined, undefined, undefined, undefined, audit, guard)
    assert.equal(options.audit, audit)
    assert.equal(options.rateLimit, guard)
})
