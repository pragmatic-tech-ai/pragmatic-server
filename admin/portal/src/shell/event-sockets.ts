import { BrowserPage, type IPageLocation } from '@pragmatic-tech-ai/pragmatic-app-shell'

// One open events socket, as the client uses it: text frames in, a close notification, and Close.
export interface IEventSocket
{
    OnMessage(handler: (data: string) => void): void
    OnClose(handler: () => void): void
    Close(): void
}

// Opens the console's sockets: each carries its single-use ticket as its lone subprotocol (the host refuses an
// upgrade without one). Location is the page's own, so a socket stays on the console's origin. Tests supply fakes.
export interface IEventSocketFactory
{
    readonly Location: IPageLocation
    Open(url: string, ticket: string): IEventSocket
}

// A browser WebSocket behind IEventSocket.
export class BrowserEventSocket implements IEventSocket
{
    private static readonly MessageEvent = 'message'
    private static readonly CloseEvent = 'close'

    private readonly socket: WebSocket

    public constructor(url: string, ticket: string)
    {
        this.socket = new globalThis.WebSocket(url, [ticket])
    }

    public OnMessage(handler: (data: string) => void): void
    {
        this.socket.addEventListener(BrowserEventSocket.MessageEvent, (ev: Event) => { handler(String((ev as MessageEvent).data)) })
    }

    public OnClose(handler: () => void): void
    {
        this.socket.addEventListener(BrowserEventSocket.CloseEvent, () => { handler() })
    }

    public Close(): void
    {
        this.socket.close()
    }
}

// The real sockets: browser WebSockets on the page's own location.
export class BrowserEventSockets implements IEventSocketFactory
{
    public get Location(): IPageLocation
    {
        return BrowserPage.Location
    }

    public Open(url: string, ticket: string): IEventSocket
    {
        return new BrowserEventSocket(url, ticket)
    }
}
