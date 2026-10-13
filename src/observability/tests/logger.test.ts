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

class StdoutProbe
{
    public Writes = 0
    private original: typeof process.stdout.write | undefined

    public Install(): void
    {
        this.original = process.stdout.write
        process.stdout.write = ((): boolean =>
        {
            this.Writes++
            return true
        }) as typeof process.stdout.write
    }

    public Restore(): void
    {
        if (this.original !== undefined)
        {
            process.stdout.write = this.original
        }
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

test('every explicitly denied name is dropped', () =>
{
    const capture = new Capture()
    const logger = StructuredLogger.ToSink(capture.Sink)
    logger.Info('x', {
        code: 'c1',
        verifier: 'v1',
        secret: 's1',
        fingerprint: 'f1',
        sessionId: 'sid1',
        bearer: 'b1',
        masterKey: 'm1',
        keep: 'ok',
    })
    const record = capture.Last()
    for (const name of ['code', 'verifier', 'secret', 'fingerprint', 'sessionId', 'bearer', 'masterKey'])
    {
        assert.equal(record[name], undefined, name)
    }
    assert.equal(record.keep, 'ok')
    assert.ok(!capture.Lines[0]!.includes('s1'))
})

test('denied names match case-insensitively and across _ and - separators', () =>
{
    const capture = new Capture()
    const logger = StructuredLogger.ToSink(capture.Sink)
    logger.Info('x', {
        Password: 'leak-a',
        AUTHORIZATION: 'leak-b',
        ClientSecret: 'leak-c',
        redis_url: 'leak-d',
        'x-authorization': 'leak-e',
        accessToken: 'leak-f',
        refreshToken: 'leak-g',
        Client_Secret_Key: 'leak-h',
        apiKey: 'kept',
    })
    const line = capture.Lines[0]!
    for (const leak of ['leak-a', 'leak-b', 'leak-c', 'leak-d', 'leak-e', 'leak-f', 'leak-g', 'leak-h'])
    {
        assert.ok(!line.includes(leak), leak)
    }
    assert.equal(capture.Last().apiKey, 'kept')
})

test('secrets are redacted inside nested objects', () =>
{
    const capture = new Capture()
    const logger = StructuredLogger.ToSink(capture.Sink)
    const redis = 'redis://user:nested-secret@cache.internal:6379'
    logger.Info('nested', { config: { password: 'nested-pw', redisUrl: redis, region: 'eu' } })
    const line = capture.Lines[0]!
    assert.ok(!line.includes('nested-pw'))
    assert.ok(!line.includes(redis))
    const config = capture.Last().config as Record<string, unknown>
    assert.equal(config.password, undefined)
    assert.equal(config.redisUrl, undefined)
    assert.equal(config.region, 'eu')
})

test('secrets are redacted inside arrays of objects', () =>
{
    const capture = new Capture()
    const logger = StructuredLogger.ToSink(capture.Sink)
    logger.Info('array', { items: [{ Token: 'arr-tok-1', ok: 1 }, { clientSecret: 'arr-sec-2', ok: 2 }] })
    const line = capture.Lines[0]!
    assert.ok(!line.includes('arr-tok-1'))
    assert.ok(!line.includes('arr-sec-2'))
    const items = capture.Last().items as Record<string, unknown>[]
    assert.equal(items.length, 2)
    assert.equal(items[0]!.Token, undefined)
    assert.equal(items[0]!.ok, 1)
    assert.equal(items[1]!.clientSecret, undefined)
    assert.equal(items[1]!.ok, 2)
})

test('Error extra props are redacted while name and message survive', () =>
{
    const capture = new Capture()
    const logger = StructuredLogger.ToSink(capture.Sink)
    const error = Object.assign(new Error('upstream failed'), { password: 'err-pw', status: 502 })
    logger.Error('failed', { err: error })
    const line = capture.Lines[0]!
    assert.ok(!line.includes('err-pw'))
    const err = capture.Last().err as Record<string, unknown>
    assert.equal(err.password, undefined)
    assert.equal(err.status, 502)
    assert.equal(err.message, 'upstream failed')
    assert.equal(err.name, 'Error')
})

test('circular references are guarded and do not loop', () =>
{
    const capture = new Capture()
    const logger = StructuredLogger.ToSink(capture.Sink)
    const node: Record<string, unknown> = { label: 'loop' }
    node.self = node
    logger.Info('circular', { node })
    const record = capture.Last()
    const inner = record.node as Record<string, unknown>
    assert.equal(inner.label, 'loop')
    assert.equal(typeof inner.self, 'string')
})

test('caller fields cannot spoof reserved message and level keys', () =>
{
    const capture = new Capture()
    const logger = StructuredLogger.ToSink(capture.Sink)
    logger.Info('real message', { message: 'fake', level: 'error', Timestamp: 'forged', tenant: 't1' })
    const record = capture.Last()
    assert.equal(record.message, 'real message')
    assert.equal(record.level, LogLevel.Info)
    assert.notEqual(record.timestamp, 'forged')
    assert.equal(record.tenant, 't1')
})

test('bound Child fields cannot spoof reserved keys either', () =>
{
    const capture = new Capture()
    const child = StructuredLogger.ToSink(capture.Sink).Child({ level: 'error', message: 'bound' })
    child.Warn('real')
    const record = capture.Last()
    assert.equal(record.level, LogLevel.Warn)
    assert.equal(record.message, 'real')
})

test('an unserializable field (BigInt) emits the fallback record instead of throwing', () =>
{
    const capture = new Capture()
    const logger = StructuredLogger.ToSink(capture.Sink)
    assert.doesNotThrow(() => logger.Error('big', { count: BigInt(10) }))
    assert.equal(capture.Lines.length, 1)
    const record = capture.Last()
    assert.equal(record.level, LogLevel.Error)
    assert.equal(record.message, 'big')
    assert.equal(typeof record.timestamp, 'string')
    assert.equal(record.logError, 'unserializable fields')
    assert.equal(record.count, undefined)
})

test('ToStdout writes through process.stdout', () =>
{
    const probe = new StdoutProbe()
    probe.Install()
    try
    {
        StructuredLogger.ToStdout().Info('to stdout')
    }
    finally
    {
        probe.Restore()
    }
    assert.equal(probe.Writes, 1)
})

test('NullLogger writes nothing to stdout and returns itself from Child', () =>
{
    const probe = new StdoutProbe()
    probe.Install()
    try
    {
        const logger = new NullLogger()
        assert.equal(logger.Child({ a: 1 }), logger)
        logger.Info('ignored', { a: 1 })
        logger.Warn('ignored')
        logger.Error('ignored', { b: 2 })
    }
    finally
    {
        probe.Restore()
    }
    assert.equal(probe.Writes, 0)
})
