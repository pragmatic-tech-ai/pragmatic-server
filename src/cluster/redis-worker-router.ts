import { createClient } from 'redis'
import type { RedisClientType } from 'redis'
import { ClusterKeys } from './cluster-keys.js'
import type { IWorkerRouter, WorkerEndpoint } from './worker-router.js'

/** No live worker is available to serve a tenant. */
export class NoWorkersAvailableError extends Error
{
    private static readonly ErrorName = 'NoWorkersAvailableError'
    private static readonly Message = 'no live workers available'

    public constructor()
    {
        super(NoWorkersAvailableError.Message)
        this.name = NoWorkersAvailableError.ErrorName
    }
}

/** Best-effort tenant->worker routing over Redis (correctness is the worker's ownership lease, not this router): reads the
 *  live-worker set, renews an active route whose worker is still live, else deterministically picks a live worker and
 *  claims the route under a TTL. The URL may carry credentials and is never logged. Injectable clock + clientFactory. */
export class RedisWorkerRouter implements IWorkerRouter
{
    private static readonly RouteTtlMs = 30_000
    private static readonly PlusInf = '+inf'
    private static readonly ErrorEvent = 'error'
    private static readonly RenewScript = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end"

    private readonly url: string
    private readonly now: () => number
    private readonly clientFactory: () => RedisClientType
    private client: RedisClientType | null = null
    private connecting: Promise<RedisClientType> | null = null

    public constructor(url: string, now: () => number = () => Date.now(), clientFactory?: () => RedisClientType)
    {
        this.url = url
        this.now = now
        this.clientFactory = clientFactory ?? (() => createClient({ url: this.url }) as RedisClientType)
    }

    public async RouteOrSpawn(tenantId: string): Promise<WorkerEndpoint>
    {
        const client = await this.Connected()
        const live = await client.zRangeByScore(ClusterKeys.Workers, this.now(), RedisWorkerRouter.PlusInf)
        if (live.length === 0)
        {
            throw new NoWorkersAvailableError()
        }
        const key = ClusterKeys.RoutePrefix + tenantId
        const existing = await client.get(key)
        // The route value and live-set members are the SAME encoding (WorkerRegistration writes JSON.stringify(endpoint)), so a byte match means the claimed worker is still live.
        if (existing !== null && live.includes(existing))
        {
            await client.eval(RedisWorkerRouter.RenewScript, { keys: [key], arguments: [existing, String(RedisWorkerRouter.RouteTtlMs)] })
            return JSON.parse(existing) as WorkerEndpoint
        }
        const pick = RedisWorkerRouter.Pick(tenantId, live)
        if (existing === null)
        {
            const claimed = await client.set(key, pick, { NX: true, PX: RedisWorkerRouter.RouteTtlMs })
            if (claimed === null)
            {
                const winner = await client.get(key)
                if (winner !== null)
                {
                    return JSON.parse(winner) as WorkerEndpoint
                }
            }
            return JSON.parse(pick) as WorkerEndpoint
        }
        await client.set(key, pick, { PX: RedisWorkerRouter.RouteTtlMs })
        return JSON.parse(pick) as WorkerEndpoint
    }

    public async Drain(): Promise<void>
    {
        const client = this.client
        this.client = null
        if (client !== null)
        {
            await client.quit().catch(() => {})
        }
    }

    /** Deterministic stable pick so every gateway indexes the same sorted live list (FNV-1a over the tenant id). */
    private static Pick(tenantId: string, live: readonly string[]): string
    {
        const sorted = [...live].sort()
        let hash = 2166136261
        for (let i = 0; i < tenantId.length; i++)
        {
            hash ^= tenantId.charCodeAt(i)
            hash = Math.imul(hash, 16777619)
        }
        const index = (hash >>> 0) % sorted.length
        return sorted[index]!
    }

    private async Connected(): Promise<RedisClientType>
    {
        if (this.client !== null && this.client.isOpen)
        {
            return this.client
        }
        this.client = null
        if (this.connecting === null)
        {
            this.connecting = this.Connect().finally(() =>
            {
                this.connecting = null
            })
        }
        return this.connecting
    }

    private async Connect(): Promise<RedisClientType>
    {
        const client = this.clientFactory()
        client.on(RedisWorkerRouter.ErrorEvent, () => {})
        try
        {
            await client.connect()
        }
        catch (error)
        {
            await client.quit().catch(() => {})
            throw error
        }
        this.client = client
        return client
    }
}
