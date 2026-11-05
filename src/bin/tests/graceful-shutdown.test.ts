import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GracefulShutdown } from '../graceful-shutdown.js'
import { StructuredLogger } from '../../observability/logger.js'
import type { AccessAuditEvent, IAccessAuditSink } from '../../host/access-audit.js'

class Steps
{
    public readonly Order: string[] = []
    public HostError: Error | undefined

    public Host(): { DisposeAsync(): Promise<void> }
    {
        return {
            DisposeAsync: async () =>
            {
                this.Order.push('host')
                if (this.HostError !== undefined)
                {
                    throw this.HostError
                }
            },
        }
    }

    public Audit(): IAccessAuditSink
    {
        return {
            Record: async (_e: AccessAuditEvent) => undefined,
            Drain: async () => { this.Order.push('audit-drain') },
        }
    }

    public Bundle(): { Dispose(): Promise<void> }
    {
        return { Dispose: async () => { this.Order.push('bundle') } }
    }
}

class Logs
{
    public readonly Lines: Array<Record<string, unknown>> = []

    public Logger(): StructuredLogger
    {
        return StructuredLogger.ToSink(line => this.Lines.push(JSON.parse(line) as Record<string, unknown>))
    }
}

test('shutdown stops the host, then drains the audit sink, then disposes the cloud bundle (whose pool the audit writes use)', async () =>
{
    const steps = new Steps()
    const logs = new Logs()
    const code = await new GracefulShutdown(steps.Host(), steps.Audit(), steps.Bundle(), logs.Logger(), 'p shutting down', 'p shutdown error: ').Run()
    assert.equal(code, 0)
    assert.deepEqual(steps.Order, ['host', 'audit-drain', 'bundle'])
    assert.equal(logs.Lines[0]!.message, 'p shutting down')
})

test('a host dispose failure is logged, the audit is still drained and the bundle disposed, and the exit code is 1', async () =>
{
    const steps = new Steps()
    steps.HostError = new Error('boom')
    const logs = new Logs()
    const code = await new GracefulShutdown(steps.Host(), steps.Audit(), undefined, logs.Logger(), 'p shutting down', 'p shutdown error: ').Run()
    assert.equal(code, 1)
    assert.deepEqual(steps.Order, ['host', 'audit-drain'])
    assert.ok(logs.Lines.some(l => l.message === 'p shutdown error: boom' && l.event === 'shutdown-error'))
})

test('a second Run is a no-op that reports success without repeating the steps', async () =>
{
    const steps = new Steps()
    const shutdown = new GracefulShutdown(steps.Host(), steps.Audit(), steps.Bundle(), new Logs().Logger(), 'a', 'b')
    await shutdown.Run()
    assert.equal(await shutdown.Run(), undefined)
    assert.deepEqual(steps.Order, ['host', 'audit-drain', 'bundle'])
})
