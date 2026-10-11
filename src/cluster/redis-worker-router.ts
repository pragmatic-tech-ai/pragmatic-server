import { createClient } from 'redis'
import type { RedisClientType } from 'redis'
import type { IWorkerRouter, WorkerEndpoint } from './worker-router.js'

/** Multi-worker tenant→worker routing over Redis: a worker claims a tenant under a TTL-leased key and others
 *  route to the claimant until the lease lapses. Gated-live (needs a real Redis). The connection URL may carry
 *  credentials and is never logged. */
export class RedisWorkerRouter implements IWorkerRouter
{
    private static readonly KeyPrefix = 'pragmatic:route:'
    private static readonly LeaseTtlMs = 30_000
    private static readonly ErrorEvent = 'error'

    private readonly url: string
    private readonly self: WorkerEndpoint
    private readonly now: () => number
    private readonly claimed = new Set<string>()
    private client: RedisClientType | null = null

    public constructor(url: string, self: WorkerEndpoint, now: () => number = () => Date.now())
    {
        this.url = url
        this.self = self
        this.now = now
    }

    public async RouteOrSpawn(tenantId: string): Promise<WorkerEndpoint>
    {
        const client = await this.Connected()
        const key = `${RedisWorkerRouter.KeyPrefix}${tenantId}`
        const claimed = await client.set(key, JSON.stringify(this.self), { NX: true, PX: RedisWorkerRouter.LeaseTtlMs })
        if (claimed !== null)
        {
            this.claimed.add(key)
            return this.self
        }
        const existing = await client.get(key)
        if (existing !== null)
        {
            await client.pExpire(key, RedisWorkerRouter.LeaseTtlMs)
            return JSON.parse(existing) as WorkerEndpoint
        }
        return this.self
    }

    public async Drain(): Promise<void>
    {
        if (this.client === null)
        {
            return
        }
        const client = this.client
        this.client = null
        try
        {
            const mine = JSON.stringify(this.self)
            for (const key of this.claimed)
            {
                const current = await client.get(key)
                if (current === mine)
                {
                    await client.del(key)
                }
            }
            this.claimed.clear()
        }
        finally
        {
            await client.quit()
        }
    }

    private async Connected(): Promise<RedisClientType>
    {
        if (this.client === null)
        {
            const client: RedisClientType = createClient({ url: this.url })
            client.on(RedisWorkerRouter.ErrorEvent, () => {})
            await client.connect()
            this.client = client
        }
        return this.client
    }
}
