import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DeploymentMode } from '../../platform/deployment-mode.js'
import { ServerBootstrap } from '../server-bootstrap.js'
import { StructuredLogger, LogLevel } from '../../observability/logger.js'
import type { ServerConfig } from '../../config/server-config.js'

class Capture
{
    public readonly Records: Array<Record<string, unknown>> = []

    public Logger(): StructuredLogger
    {
        return StructuredLogger.ToSink(line => this.Records.push(JSON.parse(line) as Record<string, unknown>))
    }
}

class Fixtures
{
    public static readonly StartupEvent = 'startup'
    public static readonly ShutdownErrorEvent = 'shutdown-error'
    public static readonly ShutdownErrorMessage = 'pragmatic-server shutdown error: boom'

    private static readonly KeyPath = '/run/secrets/key'

    public static LeaksKeyPath(text: string): boolean
    {
        return text.includes(Fixtures.KeyPath)
    }

    public static Config(): ServerConfig
    {
        return { host: '0.0.0.0', port: 8080, baseDir: '/data', masterKey: { keyFilePath: Fixtures.KeyPath }, deploymentMode: DeploymentMode.Local, singleTenant: { id: 't1', displayName: 'Tenant One' } }
    }
}

test('the startup line is logged verbatim as the message through the logger', () =>
{
    const capture = new Capture()
    const logger = capture.Logger()
    const line = ServerBootstrap.StartupLine(Fixtures.Config(), 1)
    logger.Info(line, { event: Fixtures.StartupEvent })
    assert.equal(capture.Records.length, 1)
    assert.equal(capture.Records[0]!.message, line)
    assert.equal(capture.Records[0]!.level, LogLevel.Info)
    assert.equal(capture.Records[0]!.event, Fixtures.StartupEvent)
})

test('a shutdown-error line is logged at error level and never leaks the master key target', () =>
{
    const capture = new Capture()
    const logger = capture.Logger()
    logger.Error(Fixtures.ShutdownErrorMessage, { event: Fixtures.ShutdownErrorEvent })
    assert.equal(capture.Records[0]!.level, LogLevel.Error)
    assert.ok(!Fixtures.LeaksKeyPath(JSON.stringify(capture.Records[0])))
})
