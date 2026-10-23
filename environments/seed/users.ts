import http from 'node:http'
import { WebSocket } from 'ws'
import { AdminProtocol, WsMessageSocket, WebSocketMessageReader, WebSocketMessageWriter, createMessageConnection, NullLogger } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { MessageConnection } from '@pragmatic-tech-ai/pragmatic-protocol'

export type UserSeed = { principalId: string; email: string; passwordRef: string; coarseRole: string; password?: string }

/** Logs into a running server and seeds extra accounts + coarse role grants over the admin protocol. */
export class UserSeeder
{
    private static readonly LoginPath = '/auth/login'
    private static readonly TenantQuery = '?environment='
    private static readonly WsPath = '/'
    private static readonly BearerPrefix = 'Bearer '
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly JsonContentType = 'application/json'
    private static readonly PostMethod = 'POST'
    private static readonly DataEvent = 'data'
    private static readonly EndEvent = 'end'
    private static readonly ErrorEvent = 'error'
    private static readonly OpenEvent = 'open'
    private static readonly TenantResourceKind = 'Tenant'
    private static readonly AlreadyExistsText = 'already exists'
    private static readonly LoginFailedPrefix = 'login failed with HTTP '
    private static readonly MissingPasswordPrefix = 'no password resolved for user '
    private static readonly MissingTokenMessage = 'login response contained no token'
    private static readonly HttpOkMin = 200
    private static readonly HttpOkMax = 300

    public static LoginBody(email: string, password: string): string
    {
        return JSON.stringify({ email, password })
    }

    public static BearerHeader(token: string): { Authorization: string }
    {
        return { Authorization: UserSeeder.BearerPrefix + token }
    }

    public async Login(baseHttpUrl: string, tenant: string, email: string, password: string): Promise<string>
    {
        const url = `${baseHttpUrl}${UserSeeder.LoginPath}${UserSeeder.TenantQuery}${encodeURIComponent(tenant)}`
        const body = UserSeeder.LoginBody(email, password)
        const result = await new Promise<{ status: number; text: string }>((resolve, reject) =>
        {
            const req = http.request(url, { method: UserSeeder.PostMethod, headers: { [UserSeeder.ContentTypeHeader]: UserSeeder.JsonContentType } }, res =>
            {
                const chunks: Buffer[] = []
                res.on(UserSeeder.DataEvent, (c: Buffer) => chunks.push(c))
                res.on(UserSeeder.EndEvent, () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString() }))
            })
            req.on(UserSeeder.ErrorEvent, reject)
            req.end(body)
        })
        if (result.status < UserSeeder.HttpOkMin || result.status >= UserSeeder.HttpOkMax)
        {
            throw new Error(UserSeeder.LoginFailedPrefix + result.status)
        }
        const token = (JSON.parse(result.text) as { token?: unknown }).token
        if (typeof token !== 'string' || token === '')
        {
            throw new Error(UserSeeder.MissingTokenMessage)
        }
        return token
    }

    public async Connect(wsUrl: string, tenant: string, token: string): Promise<MessageConnection>
    {
        const ws = new WebSocket(`${wsUrl}${UserSeeder.WsPath}${UserSeeder.TenantQuery}${encodeURIComponent(tenant)}`, { headers: UserSeeder.BearerHeader(token) })
        await new Promise<void>((resolve, reject) =>
        {
            ws.once(UserSeeder.OpenEvent, () => resolve())
            ws.once(UserSeeder.ErrorEvent, reject)
        })
        const socket = new WsMessageSocket(ws)
        const connection = createMessageConnection(new WebSocketMessageReader(socket), new WebSocketMessageWriter(socket), NullLogger)
        connection.listen()
        return connection
    }

    public async SeedUsers(conn: MessageConnection, users: UserSeed[]): Promise<void>
    {
        const missing = users.find(u => u.password === undefined)
        if (missing !== undefined)
        {
            throw new Error(UserSeeder.MissingPasswordPrefix + missing.principalId)
        }
        for (const user of users)
        {
            try
            {
                await conn.sendRequest(AdminProtocol.CreateAccount, { email: user.email, principalId: user.principalId, password: user.password })
            }
            catch (err)
            {
                if (!UserSeeder.IsAlreadyExists(err))
                {
                    throw err
                }
            }
            await conn.sendRequest(AdminProtocol.GrantRole, { subject: user.principalId, role: user.coarseRole, resourceKind: UserSeeder.TenantResourceKind, resourcePath: [] })
        }
    }

    private static IsAlreadyExists(err: unknown): boolean
    {
        return err instanceof Error && err.message.includes(UserSeeder.AlreadyExistsText)
    }
}
