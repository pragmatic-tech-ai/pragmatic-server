import { createClient } from 'redis'
import type { RedisClientType } from 'redis'
import { OidcFlowState } from '@pragmatic-tech-ai/todl-identity-cloud'
import type { IOidcFlowStateStore } from '@pragmatic-tech-ai/todl-identity-cloud'

/** OIDC login flow state shared across replicas over Redis: tenant-namespaced keys, TTL-bound, single-use via GETDEL.
 *  Fail-closed: a Redis error on Put aborts the login start (sanitized error); on Take it reads as absent/expired.
 *  The URL may carry credentials, and the payload holds the nonce and PKCE verifier; none of it is ever logged. */
export class RedisOidcFlowStateStore implements IOidcFlowStateStore
{
    private static readonly DefaultTtlMs = 600_000
    private static readonly ConnectTimeoutMs = 3_000
    private static readonly MaxReconnectAttempts = 10
    private static readonly CommandTimeoutMs = 3_000
    private static readonly CommandTimedOutText = 'redis command timed out'
    private static readonly UnavailableText = 'redis unavailable'
    private static readonly PutFailedText = 'oidc flow state store unavailable'
    private static readonly ErrorEvent = 'error'

    private readonly url: string
    private readonly keyPrefix: string
    private readonly now: () => Date
    private readonly clientFactory: () => RedisClientType
    private client: RedisClientType | null = null
    private connecting: Promise<RedisClientType> | null = null

    public constructor(url: string, keyPrefix: string, now: () => Date = () => new Date(), clientFactory?: () => RedisClientType)
    {
        this.url = url
        this.keyPrefix = keyPrefix
        this.now = now
        this.clientFactory = clientFactory ?? (() => createClient({ url: this.url, socket: { connectTimeout: RedisOidcFlowStateStore.ConnectTimeoutMs, reconnectStrategy: retries => retries >= RedisOidcFlowStateStore.MaxReconnectAttempts ? new Error(RedisOidcFlowStateStore.UnavailableText) : Math.min(retries * 100, 1000) } }) as RedisClientType)
    }

    public async Put(state: OidcFlowState): Promise<void>
    {
        const remaining = state.ExpiresAt.getTime() - this.now().getTime()
        const ttlMs = remaining > 0 ? remaining : RedisOidcFlowStateStore.DefaultTtlMs
        const value = JSON.stringify({ State: state.State, Nonce: state.Nonce, CodeVerifier: state.CodeVerifier, RedirectUri: state.RedirectUri, ExpiresAt: state.ExpiresAt.toISOString() })
        try
        {
            const client = await this.Connected()
            await this.WithTimeout(client.set(this.keyPrefix + state.State, value, { PX: ttlMs, NX: true }))
        }
        catch
        {
            throw new Error(RedisOidcFlowStateStore.PutFailedText)
        }
    }

    public async Take(state: string): Promise<OidcFlowState | null>
    {
        try
        {
            const client = await this.Connected()
            const raw = await this.WithTimeout(client.getDel(this.keyPrefix + state))
            if (raw === null)
            {
                return null
            }
            const p = JSON.parse(raw) as { State: string, Nonce: string, CodeVerifier: string, RedirectUri: string, ExpiresAt: string }
            const expiresAt = new Date(p.ExpiresAt)
            if (expiresAt.getTime() <= this.now().getTime())
            {
                return null
            }
            return new OidcFlowState(p.State, p.Nonce, p.CodeVerifier, p.RedirectUri, expiresAt)
        }
        catch
        {
            return null
        }
    }

    private async WithTimeout<T>(op: Promise<T>): Promise<T>
    {
        let timer: NodeJS.Timeout | undefined
        const timeout = new Promise<never>((_resolve, reject) =>
        {
            timer = setTimeout(() => reject(new Error(RedisOidcFlowStateStore.CommandTimedOutText)), RedisOidcFlowStateStore.CommandTimeoutMs)
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
        client.on(RedisOidcFlowStateStore.ErrorEvent, () => {})
        await client.connect()
        this.client = client
        return client
    }
}
