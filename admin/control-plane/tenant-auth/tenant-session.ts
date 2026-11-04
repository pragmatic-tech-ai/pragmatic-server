import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * A tenant-plane login session. The id handed to callers is the bearer token: never log it or put it in an error message
 * (the store itself keeps and persists only the token's SHA-256 digest). `issuedAt` is absent
 * on sessions written before it existed (it is then derived from expiresAt - ttl). `keptAt` is set on the session a rotation
 * issues (the fresh session of the user who changed their own password): it is issued in the same instant as the reset it
 * stamps, so the stamp must not refuse it.
 */
export type TenantSession = { id: string; tenantId: string; principalId: string; email?: string; expiresAt: string; issuedAt?: string; keptAt?: string; kind?: TenantSessionKind }

/** What a session authenticates: a console cookie, or the Plexus desktop bearer. A session without a kind is a Console one. */
export enum TenantSessionKind
{
    Console = 'console',
    Desktop = 'desktop',
}

/** Thrown inside a renewal's serialised change when the session is no longer live: no write is made. */
class RenewalRefused extends Error
{
}

/**
 * File-backed tenant session store keyed by the SHA-256 digest of each session's bearer token: the raw token is handed to
 * the caller once (Issue, RotateFor) and never kept or written; Validate and Revoke hash the token presented. Sessions the
 * store returns carry the caller's token as their id, so the token-keyed socket bookkeeping above it is unchanged. A file
 * written before digests (no `tokenFormat` marker, raw tokens as keys) is migrated on load by hashing its keys and rewritten
 * at once (best effort: a failed write leaves it to the next change). Temp-write + atomic rename; a missing file is empty. Every change
 * is made on copies of the maps and persisted; changes run one at a time. Grants (Issue, RotateFor) are strict: only a
 * successful write swaps the copy into memory, so a failed write leaves memory and disk as they were. Revocations
 * (Revoke, RevokeAllFor, RevokeTenant) fail CLOSED: the copy is swapped into memory even when the write fails (the error is then
 * rethrown), so an ended session is refused at once; the next successful change writes memory, which carries the
 * revocation to disk.
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
    /** tenantId -> when every session of that tenant was last ended (the tenant was deleted or its provisioning rolled back). */
    private static readonly TenantResetsKey = 'tenantResets'
    /** Marks a file whose session keys are token digests; a file without it holds raw tokens and is migrated on load. */
    private static readonly FormatKey = 'tokenFormat'
    private static readonly DigestFormat = 'sha256'
    private static readonly DigestAlgorithm = 'sha256'
    private static readonly DigestEncoding = 'base64url'
    private static readonly TokenBytes = 32
    private static readonly TokenEncoding = 'base64url'
    private static readonly FileMode = 0o600
    private static readonly CorruptMessage = 'Tenant session store file is corrupt'
    /** Mutate's failClosed flag for revocations: applied in memory even when the write fails. */
    private static readonly FailClosed = true
    /** How long a desktop session lives from issue and from each renewal. */
    public static readonly DesktopTtlMs = 7 * 24 * 60 * 60 * 1000
    /** A desktop session is renewed at most once per this interval of use. */
    public static readonly DesktopRenewalIntervalMs = 60 * 60 * 1000
    /** A desktop session never lives past this long after it was issued, however often it is used. */
    public static readonly DesktopMaxLifetimeMs = 30 * 24 * 60 * 60 * 1000

    private sessions = new Map<string, TenantSession>()
    private resets = new Map<string, Map<string, string>>()
    private tenantResets = new Map<string, string>()
    private loading: Promise<void> | null = null
    private mutationChain: Promise<void> = Promise.resolve()

    public constructor(
        private readonly filePath: string,
        private readonly ttlMs: number,
        private readonly now: () => Date = () => new Date(),
        private readonly desktopTtlMs: number = TenantSessionStore.DesktopTtlMs)
    {
    }

    public async Issue(tenantId: string, principalId: string, email?: string, kind: TenantSessionKind = TenantSessionKind.Console): Promise<TenantSession>
    {
        const token = TenantSessionStore.NewToken()
        return await this.Mutate((sessions) =>
        {
            const issuedAt = this.now()
            const lifetimeMs = kind === TenantSessionKind.Desktop ? this.desktopTtlMs : this.ttlMs
            const session: TenantSession = {
                id: TenantSessionStore.DigestOf(token),
                tenantId,
                principalId,
                expiresAt: new Date(issuedAt.getTime() + lifetimeMs).toISOString(),
                issuedAt: issuedAt.toISOString(),
            }
            if (kind === TenantSessionKind.Desktop)
            {
                session.kind = kind
            }
            if (email !== undefined)
            {
                session.email = email
            }
            this.PruneExpired(sessions)
            sessions.set(session.id, session)
            return { ...session, id: token }
        })
    }

    /** The key a token is stored under: its SHA-256 digest (base64url). */
    public static DigestOf(token: string): string
    {
        return createHash(TenantSessionStore.DigestAlgorithm).update(token).digest(TenantSessionStore.DigestEncoding)
    }

    private static NewToken(): string
    {
        return randomBytes(TenantSessionStore.TokenBytes).toString(TenantSessionStore.TokenEncoding)
    }

    public async Validate(token: string): Promise<TenantSession | null>
    {
        await this.ensureLoaded()
        const key = TenantSessionStore.DigestOf(token)
        const session = this.sessions.get(key)
        if (session === undefined || new Date(session.expiresAt).getTime() <= this.now().getTime() || this.PredatesReset(session))
        {
            return null
        }
        if (this.IsDueForRenewal(session))
        {
            return await this.Renew(key, token)
        }
        return { ...session, id: token }
    }

    /** Whether a desktop session has gone a renewal interval without being kept (a console session never slides). */
    private IsDueForRenewal(session: TenantSession): boolean
    {
        if (session.kind !== TenantSessionKind.Desktop)
        {
            return false
        }
        const lastKeptMs = new Date(session.keptAt ?? session.issuedAt ?? session.expiresAt).getTime()
        return this.now().getTime() - lastKeptMs >= TenantSessionStore.DesktopRenewalIntervalMs
    }

    /**
     * Slides a desktop session's expiry to now + the desktop ttl, capped at its issue time + the maximum lifetime, and
     * persists it. The session is re-checked inside the serialised change: one revoked, expired or reset while this
     * waited in the queue is refused (null). A failed WRITE must not refuse a session that is still valid, so the un-slid
     * session is returned, but only if it is still present and live in memory; any other error propagates.
     */
    private async Renew(key: string, token: string): Promise<TenantSession | null>
    {
        let changed = false
        try
        {
            return await this.Mutate((sessions) =>
            {
                const current = sessions.get(key)
                if (current === undefined || !this.IsLive(current))
                {
                    throw new RenewalRefused()
                }
                if (this.IsDueForRenewal(current))
                {
                    const nowMs = this.now().getTime()
                    const issuedMs = new Date(current.issuedAt ?? current.expiresAt).getTime()
                    current.expiresAt = new Date(Math.min(nowMs + this.desktopTtlMs, issuedMs + TenantSessionStore.DesktopMaxLifetimeMs)).toISOString()
                    current.keptAt = new Date(nowMs).toISOString()
                }
                changed = true
                return { ...current, id: token }
            })
        }
        catch (err)
        {
            if (err instanceof RenewalRefused)
            {
                return null
            }
            if (!changed)
            {
                throw err
            }
            const still = this.sessions.get(key)
            return still !== undefined && this.IsLive(still) ? { ...still, id: token } : null
        }
    }

    /** Whether the session is unexpired and not predating its principal's reset. */
    private IsLive(session: TenantSession): boolean
    {
        return new Date(session.expiresAt).getTime() > this.now().getTime() && !this.PredatesReset(session)
    }

    public async Revoke(token: string): Promise<void>
    {
        await this.ensureLoaded()
        const key = TenantSessionStore.DigestOf(token)
        if (!this.sessions.has(key))
        {
            return
        }
        await this.Mutate((sessions) => { sessions.delete(key) }, TenantSessionStore.FailClosed)
    }

    /**
     * Ends every session of the principal in the tenant (e.g. after its password changed) and stamps the time, so a session
     * issued before it is refused even if it reappears; persists once; returns how many sessions ended.
     */
    public async RevokeAllFor(tenantId: string, principalId: string): Promise<number>
    {
        return await this.Mutate((sessions, resets) => this.EndAllOf(sessions, resets, tenantId, principalId), TenantSessionStore.FailClosed)
    }

    /**
     * Ends every session of the tenant, of both kinds (the tenant was deleted, or its provisioning rolled back), and stamps
     * the time tenant-wide, so a session issued before it is refused even if it reappears (a failed write lost on restart):
     * a later tenant with the same id never inherits them. Fails closed like RevokeAllFor; returns how many sessions ended.
     */
    public async RevokeTenant(tenantId: string): Promise<number>
    {
        return await this.Mutate((sessions, _resets, tenantResets) =>
        {
            tenantResets.set(tenantId, this.now().toISOString())
            let ended = 0
            for (const [id, session] of sessions)
            {
                if (session.tenantId === tenantId)
                {
                    sessions.delete(id)
                    ended++
                }
            }
            return ended
        }, TenantSessionStore.FailClosed)
    }

    /**
     * After the principal changed its own password: ends EVERY session of the principal in the tenant (the caller's too,
     * so a stolen copy of its id is useless) and issues one fresh session for the caller, kept through the reset stamped
     * now; persists once and returns the fresh session (a new bearer token: never log it).
     */
    public async RotateFor(tenantId: string, principalId: string, email?: string): Promise<TenantSession>
    {
        const token = TenantSessionStore.NewToken()
        return await this.Mutate((sessions, resets) =>
        {
            this.EndAllOf(sessions, resets, tenantId, principalId)
            const stamp = resets.get(tenantId)?.get(principalId) as string
            const session: TenantSession = {
                id: TenantSessionStore.DigestOf(token),
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
            return { ...session, id: token }
        })
    }

    /**
     * Runs one change: `change` edits copies of the sessions and resets maps (taken from memory, so they include any
     * revocation an earlier failed write already applied), the copies are persisted, and then they replace the live maps.
     * A failed write rejects; it leaves memory untouched unless `failClosed` (a revocation), in which case the copies
     * replace the live maps anyway. Changes are serialised, so each one starts from the previous one's result.
     */
    private Mutate<T>(change: (sessions: Map<string, TenantSession>, resets: Map<string, Map<string, string>>, tenantResets: Map<string, string>) => T, failClosed: boolean = false): Promise<T>
    {
        const run = this.mutationChain.then(async () =>
        {
            await this.ensureLoaded()
            const sessions = new Map<string, TenantSession>([...this.sessions].map(([id, session]) => [id, { ...session }] as [string, TenantSession]))
            const resets = new Map<string, Map<string, string>>([...this.resets].map(([tenantId, principals]) => [tenantId, new Map(principals)] as [string, Map<string, string>]))
            const tenantResets = new Map(this.tenantResets)
            const result = change(sessions, resets, tenantResets)
            try
            {
                await this.write(sessions, resets, tenantResets)
            }
            catch (err)
            {
                if (failClosed)
                {
                    this.sessions = sessions
                    this.resets = resets
                    this.tenantResets = tenantResets
                }
                throw err
            }
            this.sessions = sessions
            this.resets = resets
            this.tenantResets = tenantResets
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

    /**
     * Whether the session was issued at or before its tenant's last tenant-wide reset (nothing keeps a session through
     * that), or at or before its principal's last reset (and is not the one that reset issued).
     */
    private PredatesReset(session: TenantSession): boolean
    {
        const issuedMs = session.issuedAt !== undefined ? new Date(session.issuedAt).getTime() : new Date(session.expiresAt).getTime() - this.ttlMs
        const tenantReset = this.tenantResets.get(session.tenantId)
        if (tenantReset !== undefined && issuedMs <= new Date(tenantReset).getTime())
        {
            return true
        }
        const reset = this.resets.get(session.tenantId)?.get(session.principalId)
        if (reset === undefined)
        {
            return false
        }
        if (session.keptAt !== undefined && new Date(session.keptAt).getTime() >= new Date(reset).getTime())
        {
            return false
        }
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
        let parsed: { [TenantSessionStore.RootKey]?: Record<string, TenantSession>; [TenantSessionStore.ResetsKey]?: Record<string, Record<string, string>>; [TenantSessionStore.TenantResetsKey]?: Record<string, string>; [TenantSessionStore.FormatKey]?: string }
        try
        {
            parsed = JSON.parse(text) as typeof parsed
        }
        catch
        {
            throw new Error(TenantSessionStore.CorruptMessage)
        }
        const legacy = parsed[TenantSessionStore.FormatKey] !== TenantSessionStore.DigestFormat
        for (const [id, session] of Object.entries(parsed[TenantSessionStore.RootKey] ?? {}))
        {
            // A pre-digest file is keyed by the raw token: re-key it by the token's digest.
            const key = legacy ? TenantSessionStore.DigestOf(id) : id
            this.sessions.set(key, { ...session, id: key })
        }
        for (const [tenantId, principals] of Object.entries(parsed[TenantSessionStore.ResetsKey] ?? {}))
        {
            this.resets.set(tenantId, new Map(Object.entries(principals)))
        }
        for (const [tenantId, stamp] of Object.entries(parsed[TenantSessionStore.TenantResetsKey] ?? {}))
        {
            this.tenantResets.set(tenantId, stamp)
        }
        if (legacy && this.sessions.size > 0)
        {
            try
            {
                await this.write(this.sessions, this.resets, this.tenantResets)
            }
            catch
            {
                // Best effort: the migrated (digest-keyed) maps are in memory, and the next change persists them.
            }
        }
    }

    private async write(sessions: Map<string, TenantSession>, resets: Map<string, Map<string, string>>, tenantResets: Map<string, string>): Promise<void>
    {
        await mkdir(dirname(this.filePath), { recursive: true })
        const body = {
            [TenantSessionStore.FormatKey]: TenantSessionStore.DigestFormat,
            [TenantSessionStore.RootKey]: Object.fromEntries(sessions),
            [TenantSessionStore.ResetsKey]: Object.fromEntries([...resets].map(([tenantId, principals]) => [tenantId, Object.fromEntries(principals)])),
            [TenantSessionStore.TenantResetsKey]: Object.fromEntries(tenantResets),
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
