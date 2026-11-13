/** One HTTP answer: status plus the parsed JSON body (undefined when the body is not a JSON object). */
export type ApiAnswer = { status: number; body: Record<string, unknown> | undefined }

/** The operator API surface the live-loop tools call; the fetch-based client below and the tests' fakes implement it. */
export interface IOperatorApi
{
    Login(email: string, password: string): Promise<void>
    Call(method: string, path: string, body?: unknown): Promise<ApiAnswer>
}

/**
 * A non-browser operator API client: signs in once and sends the `cp_session` cookie on every call. Origin is never set (the
 * operator plane admits a client without one). The password is only sent in the login body: never logged or put in an error.
 */
export class OperatorApiClient implements IOperatorApi
{
    private static readonly LoginPath = '/api/login'
    private static readonly CookieName = 'cp_session'
    private static readonly CookieAssign = '='
    private static readonly CookieAttrSep = ';'
    private static readonly CookieHeader = 'Cookie'
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly JsonType = 'application/json'
    private static readonly MethodPost = 'POST'
    private static readonly StatusOk = 200
    private static readonly LoginFailedPrefix = 'operator login failed: status '

    private cookie: string | undefined

    public constructor(private readonly baseUrl: string)
    {
    }

    public async Login(email: string, password: string): Promise<void>
    {
        const C = OperatorApiClient
        const response = await fetch(this.baseUrl + C.LoginPath, {
            method: C.MethodPost,
            headers: { [C.ContentTypeHeader]: C.JsonType },
            body: JSON.stringify({ email, password }),
        })
        await response.text()
        const prefix = C.CookieName + C.CookieAssign
        const pair = response.headers.getSetCookie().map(c => c.split(C.CookieAttrSep)[0] as string).find(c => c.startsWith(prefix))
        if (response.status !== C.StatusOk || pair === undefined)
        {
            throw new Error(C.LoginFailedPrefix + String(response.status))
        }
        this.cookie = pair
    }

    public async Call(method: string, path: string, body?: unknown): Promise<ApiAnswer>
    {
        const C = OperatorApiClient
        const headers: Record<string, string> = {}
        if (body !== undefined)
        {
            headers[C.ContentTypeHeader] = C.JsonType
        }
        if (this.cookie !== undefined)
        {
            headers[C.CookieHeader] = this.cookie
        }
        const response = await fetch(this.baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
        return { status: response.status, body: OperatorApiClient.ParseObject(await response.text()) }
    }

    /** The body as a JSON object, or undefined for an empty, non-JSON or non-object body. */
    public static ParseObject(text: string): Record<string, unknown> | undefined
    {
        try
        {
            const parsed: unknown = JSON.parse(text)
            return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
        }
        catch
        {
            return undefined
        }
    }
}
