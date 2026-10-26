import { randomBytes } from 'node:crypto'

export interface EventsTicketStoreOptions
{
    ttlMs?: number
    maxTickets?: number
    now?: () => number
    randomId?: () => string
}

interface TicketEntry
{
    token: string
    expiresAt: number
}

/** Single-use, short-lived tickets that let a browser authenticate the events WebSocket via its subprotocol (no token in the URL). */
export class EventsTicketStore
{
    private static readonly DefaultTtlMs = 30_000
    private static readonly DefaultMaxTickets = 1024
    private static readonly IdBytes = 24
    private static readonly IdEncoding = 'hex'

    private readonly tickets = new Map<string, TicketEntry>()
    private readonly ttlMs: number
    private readonly maxTickets: number
    private readonly now: () => number
    private readonly randomId: () => string

    public constructor(options: EventsTicketStoreOptions = {})
    {
        this.ttlMs = options.ttlMs ?? EventsTicketStore.DefaultTtlMs
        this.maxTickets = options.maxTickets ?? EventsTicketStore.DefaultMaxTickets
        this.now = options.now ?? (() => Date.now())
        this.randomId = options.randomId ?? (() => randomBytes(EventsTicketStore.IdBytes).toString(EventsTicketStore.IdEncoding))
    }

    /** Mints an opaque single-use ticket bound to the session token. */
    public Mint(token: string): string
    {
        this.Prune()
        while (this.tickets.size >= this.maxTickets)
        {
            const oldest = this.tickets.keys().next()
            if (oldest.done === true)
            {
                break
            }
            this.tickets.delete(oldest.value)
        }
        const ticket = this.randomId()
        this.tickets.set(ticket, { token, expiresAt: this.now() + this.ttlMs })
        return ticket
    }

    /** Returns the bound session token exactly once; null when unknown, expired, or already used. */
    public Redeem(ticket: string): string | null
    {
        const entry = this.tickets.get(ticket)
        if (entry === undefined)
        {
            return null
        }
        this.tickets.delete(ticket)
        return entry.expiresAt > this.now() ? entry.token : null
    }

    private Prune(): void
    {
        const t = this.now()
        for (const [id, entry] of this.tickets)
        {
            if (entry.expiresAt <= t)
            {
                this.tickets.delete(id)
            }
        }
    }
}
