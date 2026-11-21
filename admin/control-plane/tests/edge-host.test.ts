import { strict as assert } from 'node:assert'
import { request } from 'node:http'
import { afterEach, describe, it } from 'node:test'
import type { AgentChannelReply, AgentChannelRequest, IAgentChannelBackend, DiscoveryReply, IDesktopDiscoveryBackend } from '@pragmatic-tech-ai/pragmatic-platform-link'
import { EdgeClientAddress } from '../edge-client-address.js'
import { EdgeHost } from '../edge-host.js'

type Reply = { status: number; body: unknown }

class EchoAgent implements IAgentChannelBackend
{
    public readonly Seen: AgentChannelRequest[] = []

    public async Handle(request: AgentChannelRequest): Promise<AgentChannelReply>
    {
        this.Seen.push(request)
        return { Status: 200, Body: { version: '1.0.0', image: 'img:1' } }
    }

    public ServesConsole(): boolean
    {
        return true
    }
}

class CountingDiscovery implements IDesktopDiscoveryBackend
{
    public Calls = 0

    public async Discover(): Promise<DiscoveryReply>
    {
        this.Calls++
        return { Status: 404, Body: { error: 'no-account' } }
    }
}

class EdgeFixture
{
    public static Send(host: EdgeHost, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply>
    {
        const addr = host.Address()
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: addr.address, port: addr.port, method, path, headers: { 'content-type': 'application/json', ...headers } }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', c => chunks.push(c as Buffer))
                res.on('end', () =>
                {
                    const text = Buffer.concat(chunks).toString('utf8')
                    resolve({ status: res.statusCode ?? 0, body: text.length === 0 ? undefined : JSON.parse(text) })
                })
            })
            req.on('error', reject)
            req.end(body)
        })
    }

    public static Discover(host: EdgeHost, xff?: string): Promise<Reply>
    {
        return EdgeFixture.Send(host, 'POST', '/api/desktop/discover', xff === undefined ? {} : { 'x-forwarded-for': xff }, JSON.stringify({ email: 'ann@acme.test' }))
    }
}

describe('EdgeClientAddress', () =>
{
    const req = (xff: string | undefined, remote: string) => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: remote } }) as never

    it('uses the socket address unless the proxy is trusted', () =>
    {
        assert.equal(EdgeClientAddress.Of(req('203.0.113.9', '127.0.0.1'), false), '127.0.0.1')
    })

    it('with a trusted proxy, uses the last forwarded hop when it looks like an address', () =>
    {
        assert.equal(EdgeClientAddress.Of(req('198.51.100.1, 203.0.113.9', '127.0.0.1'), true), '203.0.113.9')
        assert.equal(EdgeClientAddress.Of(req('2001:db8::1', '127.0.0.1'), true), '2001:db8::1')
    })

    it('falls back to the socket for a forwarded value that is not an address', () =>
    {
        assert.equal(EdgeClientAddress.Of(req('<script>', '127.0.0.1'), true), '127.0.0.1')
        assert.equal(EdgeClientAddress.Of(req('', '127.0.0.1'), true), '127.0.0.1')
        for (const junk of ['a', '....', 'ff:ff:ff', '999.1.1.1'])
        {
            assert.equal(EdgeClientAddress.Of(req(junk, '127.0.0.1'), true), '127.0.0.1', junk)
        }
    })
})

describe('EdgeHost', () =>
{
    let host: EdgeHost | undefined

    afterEach(async () =>
    {
        await host?.Close()
        host = undefined
    })

    async function Start(trustedProxy: boolean): Promise<{ agent: EchoAgent, discovery: CountingDiscovery }>
    {
        const agent = new EchoAgent()
        const discovery = new CountingDiscovery()
        host = new EdgeHost(agent, discovery, trustedProxy)
        await host.Listen(0, '127.0.0.1')
        return { agent, discovery }
    }

    it('answers /healthz, the agent channel and discovery on one listener, 404 for anything else', async () =>
    {
        const { agent, discovery } = await Start(false)
        assert.deepEqual(await EdgeFixture.Send(host!, 'GET', '/healthz'), { status: 200, body: { ok: true } })
        assert.deepEqual(await EdgeFixture.Send(host!, 'GET', '/agent/hives/h1/target', { authorization: 'Bearer tok' }), { status: 200, body: { version: '1.0.0', image: 'img:1' } })
        assert.equal(agent.Seen[0]!.Token, 'tok')
        assert.equal((await EdgeFixture.Discover(host!)).status, 404)
        assert.equal(discovery.Calls, 1)
        for (const path of ['/', '/api/hives', '/api/session', '/internal/v1/agent', '/api/desktop/discover?x=1'])
        {
            assert.equal((await EdgeFixture.Send(host!, 'GET', path)).status, 404, path)
        }
    })

    it('without a trusted proxy, a spoofed X-Forwarded-For does not dodge the 10/min throttle', async () =>
    {
        const { discovery } = await Start(false)
        for (let i = 0; i < 10; i++)
        {
            assert.equal((await EdgeFixture.Discover(host!, '198.51.100.' + String(i))).status, 404)
        }
        assert.equal((await EdgeFixture.Discover(host!, '198.51.100.99')).status, 429)
        assert.equal(discovery.Calls, 10)
    })

    it('with a trusted proxy, throttles per forwarded client address', async () =>
    {
        await Start(true)
        for (let i = 0; i < 10; i++)
        {
            await EdgeFixture.Discover(host!, '198.51.100.7')
        }
        assert.equal((await EdgeFixture.Discover(host!, '198.51.100.7')).status, 429)
        assert.equal((await EdgeFixture.Discover(host!, '198.51.100.8')).status, 404)
    })
})
