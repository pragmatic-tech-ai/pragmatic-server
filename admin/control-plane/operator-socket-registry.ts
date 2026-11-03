export interface WebSocketLike
{
    close(): void
    terminate?(): void
    on(event: string, cb: () => void): void
}

/**
 * Tracks live operator event sockets per session token so logout/expiry can close them. A socket can move to a new
 * token (Rekey) when its session's token is rotated (a self-service password change), so each socket's current token
 * is tracked separately and its close event drops it from wherever it then lives.
 */
export class OperatorSocketRegistry<T extends WebSocketLike = WebSocketLike>
{
    private static readonly CloseEvent = 'close'

    private readonly byToken = new Map<string, Set<T>>()
    private readonly tokenOf = new Map<T, string>()

    public Add(token: string, ws: T): void
    {
        this.Place(token, ws)
        ws.on(OperatorSocketRegistry.CloseEvent, () => this.Remove(ws))
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
            this.tokenOf.delete(ws)
            ws.close()
        }
    }

    /** Moves every socket of `oldToken` under `newToken` (the session's token was rotated); the sockets stay open. */
    public Rekey(oldToken: string, newToken: string): void
    {
        const set = this.byToken.get(oldToken)
        if (set === undefined || oldToken === newToken)
        {
            return
        }
        this.byToken.delete(oldToken)
        for (const ws of set)
        {
            this.Place(newToken, ws)
        }
    }

    public *All(): Iterable<T>
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
        this.tokenOf.clear()
    }

    private Place(token: string, ws: T): void
    {
        let set = this.byToken.get(token)
        if (set === undefined)
        {
            set = new Set<T>()
            this.byToken.set(token, set)
        }
        set.add(ws)
        this.tokenOf.set(ws, token)
    }

    private Remove(ws: T): void
    {
        const token = this.tokenOf.get(ws)
        if (token === undefined)
        {
            return
        }
        this.tokenOf.delete(ws)
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
