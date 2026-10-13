import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Action, ResourceKind } from '@pragmatic-tech-ai/todl-identity'
import { AuditSurface, AuditOutcome } from '../access-audit.js'
import type { AccessAuditEvent } from '../access-audit.js'
import { FileAccessAuditSink } from '../file-access-audit-sink.js'
import type { ILogger, LogFields } from '../../observability/logger.js'
import type { Counter } from '@opentelemetry/api'

class CapturingLogger implements ILogger
{
    public readonly Errors: Array<{ message: string; fields?: LogFields }> = []
    public Info(): void {}
    public Warn(): void {}
    public Error(message: string, fields?: LogFields): void { this.Errors.push({ message, fields }) }
    public Child(): ILogger { return this }
}

const FileAuditTestNewline = '\n'

const AllowEvent: AccessAuditEvent = {
    Timestamp: new Date('2026-01-01T00:00:00.000Z'),
    TenantId: 't1',
    PrincipalId: 'p1',
    Surface: AuditSurface.Rpc,
    MethodOrPath: 'solution/open',
    Action: Action.Administer,
    ResourceKind: ResourceKind.Tenant,
    ResourcePath: 'my-solution',
    Outcome: AuditOutcome.Allow,
    Reason: 'ok',
    CorrelationId: 'trace-abc',
}

test('the file line contains the expected fields and no secret substring', async () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'ps-audit-'))
    const path = join(dir, 'audit.log')
    try
    {
        await new FileAccessAuditSink(path).Record(AllowEvent)
        const lines = readFileSync(path, 'utf8').split('\n').filter(l => l.length > 0)
        assert.equal(lines.length, 1)
        const record = JSON.parse(lines[0]!) as Record<string, unknown>
        assert.equal(record.tenant, 't1')
        assert.equal(record.action, 'Administer')
        assert.equal(record.resourceKind, 'Tenant')
        assert.equal(record.outcome, 'allow')
        assert.equal(lines[0]!.includes('sk-super-secret-bearer'), false)
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('a write failure is swallowed, logged, and does not throw into the caller', async () =>
{
    const logger = new CapturingLogger()
    const sink = new FileAccessAuditSink('/nonexistent/path.log', () => { throw new Error('EACCES') }, logger)
    await sink.Record(AllowEvent)
    assert.equal(logger.Errors.length, 1)
    assert.equal(logger.Errors[0]!.fields?.surface, 'rpc')
})

test('only whitelisted keys are serialized, so an extra secret-shaped field never reaches the line', async () =>
{
    const secret = 'sk-super-secret-bearer'
    const dir = mkdtempSync(join(tmpdir(), 'ps-audit-'))
    const path = join(dir, 'audit.log')
    try
    {
        const tainted = { ...AllowEvent, Token: secret, Authorization: secret, Fingerprint: secret } as unknown as AccessAuditEvent
        await new FileAccessAuditSink(path).Record(tainted)
        const line = readFileSync(path, 'utf8').split(FileAuditTestNewline).filter(l => l.length > 0)[0]!
        const expected = ['timestamp', 'tenant', 'principal', 'surface', 'method', 'action', 'resourceKind', 'resourcePath', 'outcome', 'reason', 'correlationId']
        assert.deepEqual(Object.keys(JSON.parse(line) as Record<string, unknown>).sort(), expected.sort())
        assert.equal(line.includes(secret), false)
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('a throwing logger does not make Record throw or reject', async () =>
{
    const logger = new CapturingLogger()
    logger.Error = (): void => { throw new Error('logger down') }
    await new FileAccessAuditSink('x', () => { throw new Error('EACCES') }, logger).Record(AllowEvent)
    assert.ok(true)
})

test('a throwing meter does not make Record throw or reject', async () =>
{
    const logger = new CapturingLogger()
    const counter = { add: (): void => { throw new Error('meter down') } } as unknown as Counter
    await new FileAccessAuditSink('x', () => { throw new Error('EACCES') }, logger, counter).Record(AllowEvent)
    assert.equal(logger.Errors.length, 1)
})

test('the real appender on an unwritable path is swallowed too', async () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'ps-audit-'))
    try
    {
        const logger = new CapturingLogger()
        await new FileAccessAuditSink(join(dir, 'missing', 'audit.log'), undefined, logger).Record(AllowEvent)
        assert.equal(logger.Errors.length, 1)
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true })
    }
})
