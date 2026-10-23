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
    private static readonly MaxReconnectAttempts = 10
    private static readonly CommandTimeoutMs = 3_000
    private static readonly CommandTimedOutText = 'redis command timed out'
    private static readonly UnavailableText = 'redis unavailable'
    private static readonly ErrorEvent = 'error'
    private static readonly ReadyEvent = 'ready'
    private static readonly RenewScript = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end"
    private static readonly ReleaseScript = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

    private readonly url: string
    private readonly self: string
    private readonly now: () => number
    private readonly clientFactory: () => RedisClientType
    private renewing = false
    private readonly lastRenewMs = new Map<string, number>()
    private readonly held = new Set<string>()
    /** Keys whose Release CAS-delete failed while Redis was down; flushed on reconnect/renew. Bounded by the held-tenant set. */
    private readonly pendingReleases = new Set<string>()
    private client: RedisClientType | null = null
    private connecting: Promise<RedisClientType> | null = null
    private healthy = false
    private renew: NodeJS.Timeout | null = null
    private lost: TenantLostHandler = () => {}

    public constructor(url: string, self: string, now: () => number = () => Date.now(), clientFactory?: () => RedisClientType)
    {
        this.url = url
        this.self = self
        this.now = now
        this.clientFactory = clientFactory ?? (() => createClient({ url: this.url, socket: { connectTimeout: RedisTenantOwnership.ConnectTimeoutMs, reconnectStrategy: retries => retries >= RedisTenantOwnership.MaxReconnectAttempts ? new Error(RedisTenantOwnership.UnavailableText) : Math.min(retries * 100, 1000) } }) as RedisClientType)
    }

    public OnLost(handler: TenantLostHandler): void
    {
        this.lost = handler
    }

    public async Start(): Promise<void>
    {
        this.EnsureRenew()
        await this.Connected()
    }

    public async Acquire(environmentId: string): Promise<boolean>
    {
        const key = RedisTenantOwnership.KeyPrefix + environmentId
        if (this.held.has(key))
        {
            return true
        }
        try
        {
            const client = await this.Connected()
            const claimed = await this.WithTimeout(client.set(key, this.self, { NX: true, PX: RedisTenantOwnership.LeaseTtlMs }))
            if (claimed === null)
            {
                return false
            }
            this.held.add(key)
            this.lastRenewMs.set(key, this.now())
            this.pendingReleases.delete(key)
            this.EnsureRenew()
            return true
        }
        catch
        {
            this.healthy = false
            return false
        }
    }

    /** CAS-deletes the lease. If Redis is unreachable the delete is queued in pendingReleases and flushed on the next ready/renew that reaches Redis (instead of lingering for the full TTL). */
    public async Release(environmentId: string): Promise<void>
    {
        const key = RedisTenantOwnership.KeyPrefix + environmentId
        if (!this.held.delete(key))
        {
            return
        }
        this.lastRenewMs.delete(key)
        try
        {
            const client = await this.Connected()
            await this.WithTimeout(client.eval(RedisTenantOwnership.ReleaseScript, { keys: [key], arguments: [this.self] }))
        }
        catch
        {
            this.pendingReleases.add(key)
            this.healthy = false
        }
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
            this.lastRenewMs.clear()
            this.pendingReleases.clear()
            return
        }
        try
        {
            for (const key of this.held)
            {
                await this.WithTimeout(client.eval(RedisTenantOwnership.ReleaseScript, { keys: [key], arguments: [this.self] })).catch(() => 0)
            }
            this.held.clear()
            this.lastRenewMs.clear()
            this.pendingReleases.clear()
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

    public PendingReleaseCountForTest(): number
    {
        return this.pendingReleases.size
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
        if (this.renewing)
        {
            return
        }
        this.renewing = true
        try
        {
            if (this.client === null || !this.client.isOpen)
            {
                this.client = null
                try
                {
                    await this.Connected()
                }
                catch
                {
                    this.healthy = false
                }
            }
            const client = this.client
            if (client !== null && client.isOpen && this.pendingReleases.size > 0)
            {
                await this.FlushPendingReleases(client)
            }
            const now = this.now()
            for (const key of [...this.held])
            {
                let renewed = false
                if (client !== null && client.isOpen)
                {
                    try
                    {
                        const ok = await this.WithTimeout(client.eval(RedisTenantOwnership.RenewScript, { keys: [key], arguments: [this.self, String(RedisTenantOwnership.LeaseTtlMs)] })) as number
                        this.healthy = true
                        if (ok === 0)
                        {
                            this.Drop(key)
                            continue
                        }
                        renewed = true
                    }
                    catch
                    {
                        this.healthy = false
                    }
                }
                if (renewed)
                {
                    this.lastRenewMs.set(key, now)
                }
                else if (now - (this.lastRenewMs.get(key) ?? now) >= RedisTenantOwnership.LeaseTtlMs - RedisTenantOwnership.RenewMs)
                {
                    this.Drop(key)
                }
            }
    
        }
        finally
        {
            this.renewing = false
        }
    }

    /** Best-effort CAS-delete of keys whose Release failed while Redis was down. Stops on the first failure (Redis still flaky). */
    private async FlushPendingReleases(client: RedisClientType): Promise<void>
    {
        for (const key of [...this.pendingReleases])
        {
            if (this.held.has(key))
            {
                this.pendingReleases.delete(key)
                continue
            }
            try
            {
                await this.WithTimeout(client.eval(RedisTenantOwnership.ReleaseScript, { keys: [key], arguments: [this.self] }))
                this.pendingReleases.delete(key)
            }
            catch
            {
                this.healthy = false
                return
            }
        }
    }

    /** Give up a held key: forget it locally and fire the lost handler (fail-closed). A throwing handler is isolated. */
    private Drop(key: string): void
    {
        this.held.delete(key)
        this.lastRenewMs.delete(key)
        try
        {
            this.lost(key.slice(RedisTenantOwnership.KeyPrefix.length))
        }
        catch
        {
        }
    }

    private async WithTimeout<T>(op: Promise<T>): Promise<T>
    {
        let timer: NodeJS.Timeout | undefined
        const timeout = new Promise<never>((_resolve, reject) =>
        {
            timer = setTimeout(() => reject(new Error(RedisTenantOwnership.CommandTimedOutText)), RedisTenantOwnership.CommandTimeoutMs)
            timer.unref()
        })
        try
        {
            return await Promise.race([op, timeout])
        }
        finally
        {
            if (timer !== undefined)
            {
                clearTimeout(timer)
            }
        }
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
        const client: RedisClientType = this.clientFactory()
        client.on(RedisTenantOwnership.ErrorEvent, () =>
        {
            this.healthy = false
        })
        client.on(RedisTenantOwnership.ReadyEvent, () =>
        {
            this.healthy = true
            if (this.pendingReleases.size > 0)
            {
                void this.FlushPendingReleases(client)
            }
        })
        await client.connect()
        this.client = client
        this.healthy = true
        return client
    }
}
