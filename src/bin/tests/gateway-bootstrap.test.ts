import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InMemoryWorkerRouter, type GatewayConfig, type IWorkerRouter, type MachineTlsRef } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import { GatewayBootstrap } from '../gateway-bootstrap.js'

/** Gateway configurations the cases below start from. */
class GatewayFixture
{
    public static readonly Secret: MachineTlsRef = { certFile: '/secret/cert.pem', keyFile: '/secret/key.pem', caFile: '/secret/ca.pem' }
    public static readonly Collector = 'https://collector:4317'

    public static Base(): GatewayConfig
    {
        return { host: '0.0.0.0', port: 8080, tls: { certFile: '/c', keyFile: '/k', caFile: '/a' }, redisUrl: 'redis://x' }
    }

    public static Cluster(): GatewayConfig
    {
        return { host: '0.0.0.0', port: 8080, tls: { certFile: '/c.pem', keyFile: '/k.pem', caFile: '/ca.pem' }, redisUrl: 'redis://user:secret@r:6379', workerServerName: 'pragmatic-worker', healthPort: 8081 }
    }

    public static WithClientTls(clientTls: MachineTlsRef | undefined): GatewayConfig
    {
        return { host: '127.0.0.1', port: 1, tls: GatewayFixture.Secret, redisUrl: 'redis://x', clientTls }
    }
}

test('ComposeGatewayOptions maps the gateway config + router + server name', () =>
{
    const router = new InMemoryWorkerRouter({ host: 'x', port: 1 })
    const o = GatewayBootstrap.ComposeGatewayOptions(GatewayFixture.Cluster(), router)
    assert.equal(o.port, 8080)
    assert.equal(o.serverName, 'pragmatic-worker')
    assert.equal(o.router, router)
    assert.deepEqual(o.tls, { certFile: '/c.pem', keyFile: '/k.pem', caFile: '/ca.pem' })
})

test('ComposeGatewayOptions threads drainTimeoutMs', () =>
{
    const options = GatewayBootstrap.ComposeGatewayOptions({ ...GatewayFixture.Base(), drainTimeoutMs: 32000 }, {} as unknown as IWorkerRouter)
    assert.equal(options.drainTimeoutMs, 32000)
})

test('GatewayStartupLine reports the drain window', () =>
{
    assert.match(GatewayBootstrap.GatewayStartupLine({ ...GatewayFixture.Base(), drainTimeoutMs: 32000 }), / drain=32000/)
})

test('the gateway startup line never leaks the redis URL or TLS key path', () =>
{
    const g = GatewayBootstrap.GatewayStartupLine(GatewayFixture.Cluster())
    assert.ok(!g.includes('secret'))
    assert.ok(!g.includes('/k.pem'))
    assert.ok(!g.includes('redis://'))
    assert.ok(g.includes('8080'))
})

test('the gateway startup line is otel=off by default and otel=on without echoing the endpoint', () =>
{
    assert.match(GatewayBootstrap.GatewayStartupLine(GatewayFixture.Base()), / otel=off/)
    const gw = GatewayBootstrap.GatewayStartupLine({ ...GatewayFixture.Base(), metricsPort: 9464, otlpEndpoint: GatewayFixture.Collector })
    assert.match(gw, / otel=on/)
    assert.ok(!gw.includes(GatewayFixture.Collector))
})

test('GatewayStartupLine reports client-mtls on/off without leaking paths', () =>
{
    const on = GatewayBootstrap.GatewayStartupLine(GatewayFixture.WithClientTls(GatewayFixture.Secret))
    assert.match(on, /client-mtls=on\b/)
    assert.ok(!on.includes('/secret/'))
    assert.doesNotMatch(on, /cert\.pem|key\.pem|ca\.pem/)
    assert.match(GatewayBootstrap.GatewayStartupLine(GatewayFixture.WithClientTls(undefined)), /client-mtls=off\b/)
})
