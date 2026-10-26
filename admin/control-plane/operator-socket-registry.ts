export interface WebSocketLike
{
    close(): void
    terminate?(): void
    on(event: string, cb: () => void): void
}

/** Tracks live operator event sockets per session token so logout/expiry can close them. */
export class OperatorSocketRegistry
{
    private static readonly CloseEvent = 'close'

    private readonly byToken = new Map<string, Set<WebSocketLike>>()

    public Add(token: string, ws: WebSocketLike): void
    {
        let set = this.byToken.get(token)
        if (set === undefined)
        {
            set = new Set<WebSocketLike>()
            this.byToken.set(token, set)
        }
        set.add(ws)
        ws.on(OperatorSocketRegistry.CloseEvent, () => this.Remove(token, ws))
    }

    public CloseToken(token: string): void
    {
        const set = this.byToken.get(token)
        if (set === undefined)
        {
            return
        }
        this.byToken.delete(token)
        for (const ws of [...set])
        {
            ws.close()
        }
    }

    public *All(): Iterable<WebSocketLike>
    {
        for (const set of this.byToken.values())
        {
            yield* set
        }
    }

    public Tokens(): string[]
    {
        return [...this.byToken.keys()]
    }

    public Size(): number
    {
        let n = 0
        for (const set of this.byToken.values())
        {
            n += set.size
        }
        return n
    }

    public Clear(): void
    {
        this.byToken.clear()
    }

    private Remove(token: string, ws: WebSocketLike): void
    {
        const set = this.byToken.get(token)
        if (set === undefined)
        {
            return
        }
        set.delete(ws)
        if (set.size === 0)
        {
            this.byToken.delete(token)
        }
    }
}
