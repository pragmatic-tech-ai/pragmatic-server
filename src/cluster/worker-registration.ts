import { createClient } from 'redis'
import type { RedisClientType } from 'redis'
import type { WorkerEndpoint } from './worker-router.js'

/** Heartbeats this worker's endpoint into a Redis sorted set (scored by an expiry timestamp) so the gateway's router
 *  can route only to live workers. Fail-soft: a failed write is swallowed and retried on the next tick. The URL may
 *  carry credentials and is never logged. Injectable clock + clientFactory for deterministic non-gated tests. */
export class WorkerRegistration
{
    private static readonly WorkersKey = 'pragmatic:workers'
    private static readonly TtlMs = 30_000
    private static readonly RenewMs = 10_000
    private static readonly ErrorEvent = 'error'

    private readonly url: string
    private readonly member: string
    private readonly now: () => number
    private readonly clientFactory: () => RedisClientType
    private client: RedisClientType | null = null
    private timer: NodeJS.Timeout | null = null

    public constructor(url: string, endpoint: WorkerEndpoint, now: () => number = () => Date.now(), clientFactory?: () => RedisClientType)
    {
        this.url = url
        this.member = JSON.stringify(endpoint)
        this.now = now
        this.clientFactory = clientFactory ?? (() => createClient({ url: this.url }) as RedisClientType)
    }

    public async Start(): Promise<void>
    {
        await this.Heartbeat()
        if (this.timer === null)
        {
            this.timer = setInterval(() => void this.Heartbeat(), WorkerRegistration.RenewMs)
            this.timer.unref()
        }
    }

    public async HeartbeatNowForTest(): Promise<void>
    {
        await this.Heartbeat()
    }

    public async Drain(): Promise<void>
    {
        if (this.timer !== null)
        {
            clearInterval(this.timer)
            this.timer = null
        }
        const client = this.client
        this.client = null
        if (client === null)
        {
            return
        }
        try
        {
            await client.zRem(WorkerRegistration.WorkersKey, this.member).catch(() => 0)
        }
        finally
        {
            await client.quit().catch(() => {})
        }
    }

    private async Heartbeat(): Promise<void>
    {
        try
        {
            const client = await this.Connected()
            await client.zAdd(WorkerRegistration.WorkersKey, { score: this.now() + WorkerRegistration.TtlMs, value: this.member })
        }
        catch
        {
        }
    }

    private async Connected(): Promise<RedisClientType>
    {
        if (this.client !== null && this.client.isOpen)
        {
            return this.client
        }
        const client = this.clientFactory()
        client.on(WorkerRegistration.ErrorEvent, () => {})
        await client.connect()
        this.client = client
        return client
    }
}
