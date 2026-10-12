import { createClient } from 'redis'
import type { RedisClientType } from 'redis'
import type { ITenantOwnership, TenantLostHandler } from './tenant-ownership.js'

/** Cross-replica single-writer ownership over Redis: a replica claims a tenant under a TTL-leased key, renews it while
 *  serving, and releases it on evict/shutdown. A renewal that finds the key is no longer ours disposes the local server
 *  via the lost handler (fail-closed). The URL may carry credentials and is never logged. */
export class RedisTenantOwnership implements ITenantOwnership
{
    private static readonly KeyPrefix = 'pragmatic:own:'
    private static readonly LeaseTtlMs = 30_000
    private static readonly RenewMs = 10_000
    private static readonly ConnectTimeoutMs = 3_000
    private static readonly ErrorEvent = 'error'
    private static readonly ReadyEvent = 'ready'
    private static readonly RenewScript = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end"
    private static readonly ReleaseScript = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

    private readonly url: string
    private readonly self: string
    private readonly held = new Set<string>()
    private client: RedisClientType | null = null
    private healthy = false
    private renew: NodeJS.Timeout | null = null
    private lost: TenantLostHandler = () => {}

    public constructor(url: string, self: string)
    {
        this.url = url
        this.self = self
    }

    public OnLost(handler: TenantLostHandler): void
    {
        this.lost = handler
    }

    public async Start(): Promise<void>
    {
        await this.Connected()
    }

    public async Acquire(tenantId: string): Promise<boolean>
    {
        const key = RedisTenantOwnership.KeyPrefix + tenantId
        if (this.held.has(key))
        {
            return true
        }
        const client = await this.Connected()
        const claimed = await client.set(key, this.self, { NX: true, PX: RedisTenantOwnership.LeaseTtlMs })
        if (claimed === null)
        {
            return false
        }
        this.held.add(key)
        this.EnsureRenew()
        return true
    }

    public async Release(tenantId: string): Promise<void>
    {
        const key = RedisTenantOwnership.KeyPrefix + tenantId
        if (!this.held.delete(key))
        {
            return
        }
        const client = await this.Connected()
        await client.eval(RedisTenantOwnership.ReleaseScript, { keys: [key], arguments: [this.self] })
    }

    public async ReleaseAll(): Promise<void>
    {
        if (this.renew !== null)
        {
            clearInterval(this.renew)
            this.renew = null
        }
        const client = this.client
        this.client = null
        if (client === null)
        {
            this.held.clear()
            return
        }
        try
        {
            for (const key of this.held)
            {
                await client.eval(RedisTenantOwnership.ReleaseScript, { keys: [key], arguments: [this.self] }).catch(() => 0)
            }
            this.held.clear()
        }
        finally
        {
            await client.quit().catch(() => {})
        }
    }

    public Healthy(): boolean
    {
        return this.healthy
    }

    public async RenewNowForTest(): Promise<void>
    {
        await this.RenewAll()
    }

    private EnsureRenew(): void
    {
        if (this.renew !== null)
        {
            return
        }
        this.renew = setInterval(() => void this.RenewAll(), RedisTenantOwnership.RenewMs)
        this.renew.unref()
    }

    private async RenewAll(): Promise<void>
    {
        const client = this.client
        if (client === null)
        {
            return
        }
        for (const key of [...this.held])
        {
            try
            {
                const ok = await client.eval(RedisTenantOwnership.RenewScript, { keys: [key], arguments: [this.self, String(RedisTenantOwnership.LeaseTtlMs)] }) as number
                if (ok === 0)
                {
                    this.held.delete(key)
                    this.lost(key.slice(RedisTenantOwnership.KeyPrefix.length))
                }
            }
            catch
            {
                this.healthy = false
            }
        }
    }

    private async Connected(): Promise<RedisClientType>
    {
        if (this.client === null)
        {
            const client: RedisClientType = createClient({ url: this.url, socket: { connectTimeout: RedisTenantOwnership.ConnectTimeoutMs } })
            client.on(RedisTenantOwnership.ErrorEvent, () =>
            {
                this.healthy = false
            })
            client.on(RedisTenantOwnership.ReadyEvent, () =>
            {
                this.healthy = true
            })
            await client.connect()
            this.client = client
            this.healthy = true
        }
        return this.client
    }
}
