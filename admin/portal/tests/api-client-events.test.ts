import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { IPageLocation } from '@pragmatic-tech-ai/pragmatic-app-shell'
import { ControlPlaneClient } from '../src/api-client.js'
import type { IEventSocket, IEventSocketFactory } from '../src/shell/event-sockets.js'

class FakeSocket implements IEventSocket
{
    public Closed = false
    private message: ((data: string) => void) | undefined

    public OnMessage(handler: (data: string) => void): void
    {
        this.message = handler
    }

    public OnClose(): void
    {
    }

    public Close(): void
    {
        this.Closed = true
    }

    public Push(data: string): void
    {
        this.message?.(data)
    }
}

class FakeSockets implements IEventSocketFactory
{
    public readonly Location: IPageLocation = { protocol: 'https:', host: 'admin.example.test' }
    public readonly Opened: Array<[string, string]> = []
    public readonly Sockets: FakeSocket[] = []

    public Open(url: string, ticket: string): IEventSocket
    {
        this.Opened.push([url, ticket])
        const socket = new FakeSocket()
        this.Sockets.push(socket)
        return socket
    }
}

class TicketFetch
{
    public readonly Calls: Array<[string, RequestInit]> = []

    public constructor(private readonly status: number, private readonly body: unknown)
    {
    }

    public get Fetch(): (url: string, init: RequestInit) => Promise<Response>
    {
        return async (url, init) =>
        {
            this.Calls.push([url, init])
            return { ok: this.status < 300, status: this.status, json: async () => this.body } as Response
        }
    }
}

class Ticks
{
    public static async Settle(): Promise<void>
    {
        for (let i = 0; i < 5; i++)
        {
            await new Promise(resolve => setImmediate(resolve))
        }
    }
}

describe('ControlPlaneClient events socket', () =>
{
    let client: ControlPlaneClient | undefined

    afterEach(() => { client?.Dispose() })

    it('mints a ticket by POST /api/ws-ticket and opens /api/events on the own origin with it as the subprotocol', async () =>
    {
        const fetch = new TicketFetch(200, { ticket: 't-1' })
        const sockets = new FakeSockets()
        client = new ControlPlaneClient(sockets, fetch.Fetch)
        let changed = 0
        client.OnChanged(() => { changed++ })
        await Ticks.Settle()
        assert.deepEqual(fetch.Calls.map(([url, init]) => [url, init.method]), [['/api/ws-ticket', 'POST']])
        assert.deepEqual(sockets.Opened, [['wss://admin.example.test/api/events', 't-1']])
        sockets.Sockets[0]!.Push(JSON.stringify({ type: 'environments-changed' }))
        sockets.Sockets[0]!.Push(JSON.stringify({ type: 'other' }))
        assert.equal(changed, 1)
    })

    it('a 401 for the ticket opens no socket and raises Unauthorized (the session is gone)', async () =>
    {
        const fetch = new TicketFetch(401, { error: 'unauthenticated' })
        const sockets = new FakeSockets()
        client = new ControlPlaneClient(sockets, fetch.Fetch)
        let unauthorized = 0
        client.Unauthorized.subscribe(() => { unauthorized++ })
        client.OnChanged(() => { })
        await Ticks.Settle()
        assert.equal(sockets.Opened.length, 0)
        assert.equal(unauthorized, 1)
    })
})
