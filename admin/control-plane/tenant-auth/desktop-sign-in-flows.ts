/** A begun desktop sign-in: the tenant it is for, the loopback redirect it runs on, and the binding challenge Plexus sent. */
export type DesktopSignInFlow = { tenantId: string; redirectUri: string; bindingChallenge: string }

type StoredFlow = DesktopSignInFlow & { startedAtMs: number }

/**
 * The in-memory desktop sign-ins between begin and complete, keyed by the relying party's OIDC state. A flow lives ten
 * minutes, is single use (Take removes it whether or not it is still valid), and the store is bounded: beyond 1000 flows the
 * oldest is evicted, so unauthenticated begins cannot grow it without limit. A restart forgets every flow (the user signs
 * in again).
 */
export class DesktopSignInFlows
{
    public static readonly LifetimeMs = 10 * 60 * 1000
    public static readonly MaxFlows = 1000

    // Map preserves insertion order; Start re-inserts, so the first key is always the oldest.
    private readonly flows = new Map<string, StoredFlow>()

    public constructor(private readonly now: () => Date = () => new Date())
    {
    }

    public Start(tenantId: string, redirectUri: string, bindingChallenge: string, state: string): void
    {
        const nowMs = this.now().getTime()
        this.PruneExpired(nowMs)
        this.flows.delete(state)
        this.flows.set(state, { tenantId, redirectUri, bindingChallenge, startedAtMs: nowMs })
        while (this.flows.size > DesktopSignInFlows.MaxFlows)
        {
            const oldest = this.flows.keys().next().value as string
            this.flows.delete(oldest)
        }
    }

    public Take(state: string): DesktopSignInFlow | undefined
    {
        const flow = this.flows.get(state)
        if (flow === undefined)
        {
            return undefined
        }
        this.flows.delete(state)
        if (!this.IsLive(flow, this.now().getTime()))
        {
            return undefined
        }
        return { tenantId: flow.tenantId, redirectUri: flow.redirectUri, bindingChallenge: flow.bindingChallenge }
    }

    private IsLive(flow: StoredFlow, nowMs: number): boolean
    {
        return nowMs - flow.startedAtMs < DesktopSignInFlows.LifetimeMs
    }

    /** Drops expired flows from the oldest end, stopping at the first live one (insertion order is start order). */
    private PruneExpired(nowMs: number): void
    {
        for (const [state, flow] of this.flows)
        {
            if (this.IsLive(flow, nowMs))
            {
                return
            }
            this.flows.delete(state)
        }
    }
}
