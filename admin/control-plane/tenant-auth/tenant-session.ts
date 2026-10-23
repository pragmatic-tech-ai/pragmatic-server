import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** A tenant-plane login session. The id is the bearer token: never log it or put it in an error message. */
export type TenantSession = { id: string; tenantId: string; principalId: string; email?: string; expiresAt: string }

/** File-backed tenant session store keyed by session id (temp-write + atomic rename; a missing file is empty). */
export class TenantSessionStore
{
    private static readonly Encoding = 'utf8'
    private static readonly TempSuffix = '.tmp'
    private static readonly NotFoundCode = 'ENOENT'
    private static readonly JsonIndent = 2
    private static readonly RootKey = 'sessions'
    private static readonly TokenBytes = 32
    private static readonly TokenEncoding = 'base64url'

    private readonly sessions = new Map<string, TenantSession>()
    private loaded = false

    public constructor(
        private readonly filePath: string,
        private readonly ttlMs: number,
        private readonly now: () => Date = () => new Date())
    {
    }

    public async Issue(tenantId: string, principalId: string, email?: string): Promise<TenantSession>
    {
        await this.ensureLoaded()
        const session: TenantSession = {
            id: randomBytes(TenantSessionStore.TokenBytes).toString(TenantSessionStore.TokenEncoding),
            tenantId,
            principalId,
            expiresAt: new Date(this.now().getTime() + this.ttlMs).toISOString(),
        }
        if (email !== undefined)
        {
            session.email = email
        }
        this.sessions.set(session.id, session)
        await this.persist()
        return { ...session }
    }

    public async Validate(token: string): Promise<TenantSession | null>
    {
        await this.ensureLoaded()
        const session = this.sessions.get(token)
        if (session === undefined || new Date(session.expiresAt).getTime() <= this.now().getTime())
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

    private async ensureLoaded(): Promise<void>
    {
        if (this.loaded)
        {
            return
        }
        let text: string
        try
        {
            text = await readFile(this.filePath, TenantSessionStore.Encoding)
        }
        catch (err)
        {
            if ((err as NodeJS.ErrnoException).code === TenantSessionStore.NotFoundCode)
            {
                this.loaded = true
                return
            }
            throw err
        }
        const parsed = JSON.parse(text) as Record<string, Record<string, TenantSession> | undefined>
        for (const [id, session] of Object.entries(parsed[TenantSessionStore.RootKey] ?? {}))
        {
            this.sessions.set(id, session)
        }
        this.loaded = true
    }

    private async persist(): Promise<void>
    {
        await mkdir(dirname(this.filePath), { recursive: true })
        const body = { [TenantSessionStore.RootKey]: Object.fromEntries(this.sessions) }
        const temp = `${this.filePath}.${randomUUID()}${TenantSessionStore.TempSuffix}`
        await writeFile(temp, JSON.stringify(body, null, TenantSessionStore.JsonIndent), TenantSessionStore.Encoding)
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
