import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { AgentChannelOperation, InternalApiClient } from '@pragmatic-tech-ai/pragmatic-platform-link'
import { InternalApiCredential } from '@pragmatic-tech-ai/pragmatic-app-host'
import { RemoteAgentChannelBackend } from '../remote-agent-channel-backend.js'
import { RemoteDesktopDiscoveryBackend } from '../remote-desktop-discovery-backend.js'

class RemoteFixture
{
    public static readonly Root = mkdtempSync(join(tmpdir(), 'remote-backends-'))
    public static readonly Unavailable = { Status: 503, Body: { error: 'unavailable' } }
    public static readonly Request = { Operation: AgentChannelOperation.Target, HiveId: 'h1', Token: 't' }

    public static Credential(): InternalApiCredential
    {
        const path = join(RemoteFixture.Root, 'secret')
        writeFileSync(path, 'r'.repeat(48))
        return InternalApiCredential.FromFile(path)
    }

    /** A fake admin answering every request with the given handler. */
    public static async Admin(handle: (body: string, res: import('node:http').ServerResponse) => void): Promise<{ server: Server, url: string }>
    {
        const server = createServer((req, res) =>
        {
            const chunks: Buffer[] = []
            req.on('data', c => chunks.push(c as Buffer))
            req.on('end', () => handle(Buffer.concat(chunks).toString('utf8'), res))
        })
        await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
        return { server, url: 'http://127.0.0.1:' + String((server.address() as AddressInfo).port) }
    }

    public static Close(server: Server): Promise<void>
    {
        server.closeAllConnections()
        return new Promise(r => server.close(() => r()))
    }
}

describe('Remote backends (the edge side of the internal API)', () =>
{
    after(() => rmSync(RemoteFixture.Root, { recursive: true, force: true }))

    it('answers 503 unavailable when admin is not listening', async () =>
    {
        const { server, url } = await RemoteFixture.Admin(() => undefined)
        await RemoteFixture.Close(server)
        const client = new InternalApiClient(url, RemoteFixture.Credential())
        assert.deepEqual(await new RemoteAgentChannelBackend(client).Handle(RemoteFixture.Request), RemoteFixture.Unavailable)
        assert.deepEqual(await new RemoteDesktopDiscoveryBackend(client).Discover('a@b.c'), RemoteFixture.Unavailable)
    })

    it('answers 503 within the deadline when admin hangs', async () =>
    {
        const { server, url } = await RemoteFixture.Admin(() => undefined)
        try
        {
            const started = Date.now()
            const reply = await new RemoteAgentChannelBackend(new InternalApiClient(url, RemoteFixture.Credential(), 300)).Handle(RemoteFixture.Request)
            assert.deepEqual(reply, RemoteFixture.Unavailable)
            assert.ok(Date.now() - started < 2000)
        }
        finally
        {
            await RemoteFixture.Close(server)
        }
    })

    it('answers 503 and never admin\'s text for a non-200, non-JSON or wrongly shaped reply', async () =>
    {
        const answers: Array<[number, string]> = [[500, '{"error":"ADMIN-INTERNAL-DETAIL"}'], [401, '{"error":"unauthorized"}'], [200, 'not json ADMIN-INTERNAL-DETAIL'], [200, '{"nope":1}'], [200, '{"Status":"200"}']]
        for (const [status, text] of answers)
        {
            const { server, url } = await RemoteFixture.Admin((_body, res) =>
            {
                res.writeHead(status, { 'content-type': 'application/json' })
                res.end(text)
            })
            try
            {
                const reply = await new RemoteAgentChannelBackend(new InternalApiClient(url, RemoteFixture.Credential())).Handle(RemoteFixture.Request)
                assert.deepEqual(reply, RemoteFixture.Unavailable)
                assert.ok(!JSON.stringify(reply).includes('ADMIN-INTERNAL-DETAIL'))
            }
            finally
            {
                await RemoteFixture.Close(server)
            }
        }
    })

    it('sends the request verbatim with the internal bearer, and passes the reply through', async () =>
    {
        const credential = RemoteFixture.Credential()
        let seen: unknown
        let auth: string | undefined
        const server = createServer((req, res) =>
        {
            auth = req.headers.authorization
            const chunks: Buffer[] = []
            req.on('data', c => chunks.push(c as Buffer))
            req.on('end', () =>
            {
                seen = JSON.parse(Buffer.concat(chunks).toString('utf8'))
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ Status: 204 }))
            })
        })
        await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
        try
        {
            const url = 'http://127.0.0.1:' + String((server.address() as AddressInfo).port)
            const request = { Operation: AgentChannelOperation.Snapshot, HiveId: 'h1', Token: 't', Body: '{"environments":[]}' }
            assert.deepEqual(await new RemoteAgentChannelBackend(new InternalApiClient(url, credential)).Handle(request), { Status: 204 })
            assert.deepEqual(seen, request)
            assert.equal(auth, 'Bearer ' + credential.Bearer())
        }
        finally
        {
            await RemoteFixture.Close(server)
        }
    })
})
