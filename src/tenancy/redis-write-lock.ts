import { randomUUID } from 'node:crypto'
import type { IWriteLease, IWriteLock } from '../host/cypher/write-lock.js'
import { WriteLockBusyError } from '../host/cypher/write-lock.js'

/** The Redis commands the write lock needs (a subset of RedisClientType, so tests can fake it). */
export interface IRedisLockClient
{
    set(key: string, value: string, options: { NX: true, PX: number }): Promise<string | null>
    get(key: string): Promise<string | null>
    eval(script: string, options: { keys: string[], arguments: string[] }): Promise<unknown>
}

/** Timing of a Redis write lease: how long it lives unrenewed, how often it is renewed, and how long Acquire waits. */
export class RedisWriteLockTiming
{
    public static readonly Default = new RedisWriteLockTiming(30_000, 10_000, 10_000, 50)

    constructor(
        readonly LeaseTtlMs: number,
        readonly RenewMs: number,
        readonly AcquireTimeoutMs: number,
        readonly RetryMs: number,
    )
    {
    }
}

/**
 * Cross-process tenant write lock over Redis: SET NX PX with a per-lease random token, renewed while held, released by
 * compare-and-delete. Every worker serving the tenant contends on the same key, so plan -> authorize -> commit -> persist
 * runs on one worker at a time; `Held` re-reads the key so a lease that expired (pause, partition) is caught before the
 * persist. An unreachable Redis fails closed (WriteLockBusyError), never open.
 */
export class RedisWriteLock implements IWriteLock
{
    private static readonly KeyPrefix = 'pragmatic:write:'

    constructor(
        private readonly environmentId: string,
        private readonly client: () => Promise<IRedisLockClient>,
        private readonly timing: RedisWriteLockTiming = RedisWriteLockTiming.Default,
        private readonly now: () => number = () => Date.now(),
        private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
    )
    {
    }

    public async Acquire(): Promise<IWriteLease>
    {
        const key = RedisWriteLock.KeyPrefix + this.environmentId
        const token = randomUUID()
        const deadline = this.now() + this.timing.AcquireTimeoutMs
        for (;;)
        {
            try
            {
                const client = await this.client()
                if (await client.set(key, token, { NX: true, PX: this.timing.LeaseTtlMs }) !== null)
                {
                    return new RedisWriteLease(key, token, client, this.timing)
                }
            }
            catch
            {
                throw new WriteLockBusyError()
            }
            if (this.now() >= deadline)
            {
                throw new WriteLockBusyError()
            }
            await this.sleep(this.timing.RetryMs)
        }
    }
}

class RedisWriteLease implements IWriteLease
{
    private static readonly RenewScript = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end"
    private static readonly ReleaseScript = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"
    private renew: NodeJS.Timeout | undefined
    private lost = false

    constructor(private readonly key: string, private readonly token: string, private readonly client: IRedisLockClient, private readonly timing: RedisWriteLockTiming)
    {
        this.renew = setInterval(() => void this.Renew(), timing.RenewMs)
        this.renew.unref?.()
    }

    public async Held(): Promise<boolean>
    {
        if (this.lost) return false
        try
        {
            return await this.client.get(this.key) === this.token
        }
        catch
        {
            return false
        }
    }

    public async Release(): Promise<void>
    {
        this.StopRenewing()
        try
        {
            await this.client.eval(RedisWriteLease.ReleaseScript, { keys: [this.key], arguments: [this.token] })
        }
        catch
        {
            // unreachable Redis: the lease simply expires after its TTL
        }
    }

    private async Renew(): Promise<void>
    {
        try
        {
            const renewed = await this.client.eval(RedisWriteLease.RenewScript, { keys: [this.key], arguments: [this.token, String(this.timing.LeaseTtlMs)] })
            if (renewed === 0) this.MarkLost()
        }
        catch
        {
            this.MarkLost()
        }
    }

    private MarkLost(): void
    {
        this.lost = true
        this.StopRenewing()
    }

    private StopRenewing(): void
    {
        if (this.renew !== undefined) clearInterval(this.renew)
        this.renew = undefined
    }
}
