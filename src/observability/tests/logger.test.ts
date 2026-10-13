import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StructuredLogger, NullLogger, LogLevel } from '../logger.js'

class Capture
{
    public readonly Lines: string[] = []

    public Sink = (line: string): void =>
    {
        this.Lines.push(line)
    }

    public Last(): Record<string, unknown>
    {
        return JSON.parse(this.Lines[this.Lines.length - 1]!) as Record<string, unknown>
    }
}

test('emits one JSON line carrying level, message and fields', () =>
{
    const capture = new Capture()
    const logger = StructuredLogger.ToSink(capture.Sink)
    logger.Info('server started', { port: 8080, tenant: 't1' })
    assert.equal(capture.Lines.length, 1)
    const record = capture.Last()
    assert.equal(record.level, LogLevel.Info)
    assert.equal(record.message, 'server started')
    assert.equal(record.port, 8080)
    assert.equal(record.tenant, 't1')
    assert.equal(typeof record.timestamp, 'string')
})

test('drops denied field names and never emits a redis-url-shaped value', () =>
{
    const capture = new Capture()
    const logger = StructuredLogger.ToSink(capture.Sink)
    const redis = 'redis://user:sup3rsecret@cache.internal:6379'
    logger.Warn('config', { redisUrl: redis, password: 'p@ss', token: 'abc.def', otlpEndpoint: 'https://collector:4317', tenant: 't1' })
    const line = capture.Lines[0]!
    assert.ok(!line.includes(redis))
    assert.ok(!line.includes('p@ss'))
    assert.ok(!line.includes('abc.def'))
    assert.ok(!line.includes('https://collector:4317'))
    const record = capture.Last()
    assert.equal(record.redisUrl, undefined)
    assert.equal(record.password, undefined)
    assert.equal(record.token, undefined)
    assert.equal(record.otlpEndpoint, undefined)
    assert.equal(record.tenant, 't1')
})

test('Child merges bound context into every record and keeps the sink', () =>
{
    const capture = new Capture()
    const child = StructuredLogger.ToSink(capture.Sink).Child({ correlationId: 'trace-123', tenant: 't1' })
    child.Error('boom', { class: 'ResponseError' })
    const record = capture.Last()
    assert.equal(record.level, LogLevel.Error)
    assert.equal(record.correlationId, 'trace-123')
    assert.equal(record.tenant, 't1')
    assert.equal(record.class, 'ResponseError')
    assert.equal(record.message, 'boom')
})

test('a denied name bound via Child is still dropped', () =>
{
    const capture = new Capture()
    const child = StructuredLogger.ToSink(capture.Sink).Child({ token: 'bound-secret', tenant: 't1' })
    child.Info('x')
    assert.ok(!capture.Lines[0]!.includes('bound-secret'))
    assert.equal(capture.Last().tenant, 't1')
})

test('NullLogger writes nothing and returns itself from Child', () =>
{
    const logger = new NullLogger()
    assert.equal(logger.Child({ a: 1 }), logger)
    logger.Info('ignored', { a: 1 })
    assert.ok(true)
})
