import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * A tenant-plane login session. The id is the bearer token: never log it or put it in an error message. `issuedAt` is absent
 * on sessions written before it existed (it is then derived from expiresAt - ttl). `keptAt` is set on the session a rotation
 * issues (the fresh session of the user who changed their own password): it is issued in the same instant as the reset it
 * stamps, so the stamp must not refuse it.
 */
export type TenantSession = { id: string; tenantId: string; principalId: string; email?: string; expiresAt: string; issuedAt?: string; keptAt?: string }

/**
 * File-backed tenant session store keyed by session id (temp-write + atomic rename; a missing file is empty). Every change
 * is atomic: it is made on copies of the maps, the copy is persisted, and only a successful write swaps it into memory, so a
 * failed write leaves both memory and disk exactly as they were. Changes run one at a time.
 */
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

    private sessions = new Map<string, TenantSession>()
    private resets = new Map<string, Map<string, string>>()
    private loading: Promise<void> | null = null
    private mutationChain: Promise<void> = Promise.resolve()

    public constructor(
        private readonly filePath: string,
        private readonly ttlMs: number,
        private readonly now: () => Date = () => new Date())
    {
    }

    public async Issue(tenantId: string, principalId: string, email?: string): Promise<TenantSession>
    {
        return await this.Mutate((sessions) =>
        {
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
            this.PruneExpired(sessions)
            sessions.set(session.id, session)
            return { ...session }
        })
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
        if (!this.sessions.has(token))
        {
            return
        }
        await this.Mutate((sessions) => { sessions.delete(token) })
    }

    /**
     * Ends every session of the principal in the tenant (e.g. after its password changed) and stamps the time, so a session
     * issued before it is refused even if it reappears; persists once; returns how many sessions ended.
     */
    public async RevokeAllFor(tenantId: string, principalId: string): Promise<number>
    {
        return await this.Mutate((sessions, resets) => this.EndAllOf(sessions, resets, tenantId, principalId))
    }

    /**
     * After the principal changed its own password: ends EVERY session of the principal in the tenant (the caller's too,
     * so a stolen copy of its id is useless) and issues one fresh session for the caller, kept through the reset stamped
     * now; persists once and returns the fresh session (a new bearer token: never log it).
     */
    public async RotateFor(tenantId: string, principalId: string, email?: string): Promise<TenantSession>
    {
        return await this.Mutate((sessions, resets) =>
        {
            this.EndAllOf(sessions, resets, tenantId, principalId)
            const stamp = resets.get(tenantId)?.get(principalId) as string
            const session: TenantSession = {
                id: randomBytes(TenantSessionStore.TokenBytes).toString(TenantSessionStore.TokenEncoding),
                tenantId,
                principalId,
                expiresAt: new Date(new Date(stamp).getTime() + this.ttlMs).toISOString(),
                issuedAt: stamp,
                keptAt: stamp,
            }
            if (email !== undefined)
            {
                session.email = email
            }
            this.PruneExpired(sessions)
            sessions.set(session.id, session)
            return { ...session }
        })
    }

    /**
     * Runs one change atomically: `change` edits copies of the sessions and resets maps, the copies are persisted, and only
     * then do they replace the live maps; a failed write rejects and leaves memory untouched. Changes are serialised, so
     * each one starts from the previous one's result.
     */
    private Mutate<T>(change: (sessions: Map<string, TenantSession>, resets: Map<string, Map<string, string>>) => T): Promise<T>
    {
        const run = this.mutationChain.then(async () =>
        {
            await this.ensureLoaded()
            const sessions = new Map<string, TenantSession>([...this.sessions].map(([id, session]) => [id, { ...session }] as [string, TenantSession]))
            const resets = new Map<string, Map<string, string>>([...this.resets].map(([tenantId, principals]) => [tenantId, new Map(principals)] as [string, Map<string, string>]))
            const result = change(sessions, resets)
            await this.write(sessions, resets)
            this.sessions = sessions
            this.resets = resets
            return result
        })
        this.mutationChain = run.then(() => undefined, () => undefined)
        return run
    }

    /** Stamps the principal's reset time (now) and drops every one of its sessions from the given maps; returns how many. */
    private EndAllOf(sessions: Map<string, TenantSession>, resets: Map<string, Map<string, string>>, tenantId: string, principalId: string): number
    {
        let tenantResets = resets.get(tenantId)
        if (tenantResets === undefined)
        {
            tenantResets = new Map()
            resets.set(tenantId, tenantResets)
        }
        tenantResets.set(principalId, this.now().toISOString())
        let ended = 0
        for (const [id, session] of sessions)
        {
            if (session.tenantId === tenantId && session.principalId === principalId)
            {
                sessions.delete(id)
                ended++
            }
        }
        return ended
    }

    /** Whether the session was issued at or before its principal's last reset (and is not the one that reset issued). */
    private PredatesReset(session: TenantSession): boolean
    {
        const reset = this.resets.get(session.tenantId)?.get(session.principalId)
        if (reset === undefined)
        {
            return false
        }
        if (session.keptAt !== undefined && new Date(session.keptAt).getTime() >= new Date(reset).getTime())
        {
            return false
        }
        const issuedMs = session.issuedAt !== undefined ? new Date(session.issuedAt).getTime() : new Date(session.expiresAt).getTime() - this.ttlMs
        return issuedMs <= new Date(reset).getTime()
    }

    private PruneExpired(sessions: Map<string, TenantSession>): void
    {
        const nowMs = this.now().getTime()
        for (const [id, session] of sessions)
        {
            if (new Date(session.expiresAt).getTime() <= nowMs)
            {
                sessions.delete(id)
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

    private async write(sessions: Map<string, TenantSession>, resets: Map<string, Map<string, string>>): Promise<void>
    {
        await mkdir(dirname(this.filePath), { recursive: true })
        const body = {
            [TenantSessionStore.RootKey]: Object.fromEntries(sessions),
            [TenantSessionStore.ResetsKey]: Object.fromEntries([...resets].map(([tenantId, principals]) => [tenantId, Object.fromEntries(principals)])),
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
