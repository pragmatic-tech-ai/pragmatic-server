import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * A tenant-plane login session. The id is the bearer token: never log it or put it in an error message. `issuedAt` is absent
 * on sessions written before it existed (it is then derived from expiresAt - ttl).
 */
export type TenantSession = { id: string; tenantId: string; principalId: string; email?: string; expiresAt: string; issuedAt?: string }

/** File-backed tenant session store keyed by session id (temp-write + atomic rename; a missing file is empty). */
export class TenantSessionStore
{
    private static readonly Encoding = 'utf8'
    private static readonly TempSuffix = '.tmp'
    private static readonly NotFoundCode = 'ENOENT'
    private static readonly JsonIndent = 2
    private static readonly RootKey = 'sessions'
    /** tenantId -> principalId -> when that principal's sessions were last ended (a password reset). */
    private static readonly ResetsKey = 'principalResets'
    private static readonly TokenBytes = 32
    private static readonly TokenEncoding = 'base64url'
    private static readonly FileMode = 0o600
    private static readonly CorruptMessage = 'Tenant session store file is corrupt'

    private readonly sessions = new Map<string, TenantSession>()
    private readonly resets = new Map<string, Map<string, string>>()
    private loading: Promise<void> | null = null
    private persistChain: Promise<void> = Promise.resolve()

    public constructor(
        private readonly filePath: string,
        private readonly ttlMs: number,
        private readonly now: () => Date = () => new Date())
    {
    }

    public async Issue(tenantId: string, principalId: string, email?: string): Promise<TenantSession>
    {
        await this.ensureLoaded()
        const issuedAt = this.now()
        const session: TenantSession = {
            id: randomBytes(TenantSessionStore.TokenBytes).toString(TenantSessionStore.TokenEncoding),
            tenantId,
            principalId,
            expiresAt: new Date(issuedAt.getTime() + this.ttlMs).toISOString(),
            issuedAt: issuedAt.toISOString(),
        }
        if (email !== undefined)
        {
            session.email = email
        }
        this.pruneExpired()
        this.sessions.set(session.id, session)
        await this.persist()
        return { ...session }
    }

    public async Validate(token: string): Promise<TenantSession | null>
    {
        await this.ensureLoaded()
        const session = this.sessions.get(token)
        if (session === undefined || new Date(session.expiresAt).getTime() <= this.now().getTime() || this.PredatesReset(session))
        {
            return null
        }
        return { ...session }
    }

    public async Revoke(token: string): Promise<void>
    {
        await this.ensureLoaded()
        if (this.sessions.delete(token))
        {
            await this.persist()
        }
    }

    /**
     * Ends every session of the principal in the tenant (e.g. after its password changed) and stamps the time, so a session
     * issued before it is refused even if it reappears; persists once; returns how many sessions ended.
     */
    public async RevokeAllFor(tenantId: string, principalId: string): Promise<number>
    {
        await this.ensureLoaded()
        let tenantResets = this.resets.get(tenantId)
        if (tenantResets === undefined)
        {
            tenantResets = new Map()
            this.resets.set(tenantId, tenantResets)
        }
        tenantResets.set(principalId, this.now().toISOString())
        let ended = 0
        for (const [id, session] of this.sessions)
        {
            if (session.tenantId === tenantId && session.principalId === principalId)
            {
                this.sessions.delete(id)
                ended++
            }
        }
        await this.persist()
        return ended
    }

    /** Whether the session was issued at or before its principal's last reset. */
    private PredatesReset(session: TenantSession): boolean
    {
        const reset = this.resets.get(session.tenantId)?.get(session.principalId)
        if (reset === undefined)
        {
            return false
        }
        const issuedMs = session.issuedAt !== undefined ? new Date(session.issuedAt).getTime() : new Date(session.expiresAt).getTime() - this.ttlMs
        return issuedMs <= new Date(reset).getTime()
    }

    private pruneExpired(): void
    {
        const nowMs = this.now().getTime()
        for (const [id, session] of this.sessions)
        {
            if (new Date(session.expiresAt).getTime() <= nowMs)
            {
                this.sessions.delete(id)
            }
        }
    }

    private ensureLoaded(): Promise<void>
    {
        if (this.loading === null)
        {
            this.loading = this.load().catch(err =>
            {
                this.loading = null
                throw err
            })
        }
        return this.loading
    }

    private async load(): Promise<void>
    {
        let text: string
        try
        {
            text = await readFile(this.filePath, TenantSessionStore.Encoding)
        }
        catch (err)
        {
            if ((err as NodeJS.ErrnoException).code === TenantSessionStore.NotFoundCode)
            {
                return
            }
            throw err
        }
        let parsed: { [TenantSessionStore.RootKey]?: Record<string, TenantSession>; [TenantSessionStore.ResetsKey]?: Record<string, Record<string, string>> }
        try
        {
            parsed = JSON.parse(text) as typeof parsed
        }
        catch
        {
            throw new Error(TenantSessionStore.CorruptMessage)
        }
        for (const [id, session] of Object.entries(parsed[TenantSessionStore.RootKey] ?? {}))
        {
            this.sessions.set(id, session)
        }
        for (const [tenantId, principals] of Object.entries(parsed[TenantSessionStore.ResetsKey] ?? {}))
        {
            this.resets.set(tenantId, new Map(Object.entries(principals)))
        }
    }

    private persist(): Promise<void>
    {
        const run = this.persistChain.then(() => this.write())
        this.persistChain = run.catch(() => undefined)
        return run
    }

    private async write(): Promise<void>
    {
        await mkdir(dirname(this.filePath), { recursive: true })
        const body = {
            [TenantSessionStore.RootKey]: Object.fromEntries(this.sessions),
            [TenantSessionStore.ResetsKey]: Object.fromEntries([...this.resets].map(([tenantId, principals]) => [tenantId, Object.fromEntries(principals)])),
        }
        const temp = `${this.filePath}.${randomUUID()}${TenantSessionStore.TempSuffix}`
        await writeFile(temp, JSON.stringify(body, null, TenantSessionStore.JsonIndent), { encoding: TenantSessionStore.Encoding, mode: TenantSessionStore.FileMode })
        try
        {
            await rename(temp, this.filePath)
        }
        catch (err)
        {
            await unlink(temp).catch(() => undefined)
            throw err
        }
    }
}
