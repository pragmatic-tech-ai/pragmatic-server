import { LoginConfig } from './login-config.js'
import type { LoginPageLocation } from './login-page-location.js'

// The realm sign-in service's answer to a JSON login post: the redirect back to
// the application (the response also set the SSO cookie), or why it refused.
export class LoginAnswer
{
    public static readonly InvalidCredentials = 'invalid_credentials'
    public static readonly EmailNotVerified = 'email_not_verified'
    public static readonly TooManyAttempts = 'too_many_attempts'
    // Not a server code: the post did not reach the service or its answer was unreadable.
    public static readonly Unavailable = 'unavailable'
    private static readonly RedirectField = 'redirect'
    private static readonly ErrorField = 'error'
    private static readonly DescriptionField = 'error_description'
    private static readonly StatusOk = 200

    public constructor(
        public readonly Redirect: string | undefined,
        public readonly Error: string | undefined,
        public readonly Description: string | undefined,
        public readonly RetryAfterSeconds: number | undefined)
    {
    }

    public static Redirecting(location: string): LoginAnswer
    {
        return new LoginAnswer(location, undefined, undefined, undefined)
    }

    public static Refused(error: string, description?: string, retryAfterSeconds?: number): LoginAnswer
    {
        return new LoginAnswer(undefined, error, description, retryAfterSeconds)
    }

    // Reads a response: its status, JSON body and Retry-After header (seconds).
    public static FromResponse(status: number, json: unknown, retryAfter: string | null): LoginAnswer
    {
        const A = LoginAnswer
        const body = json !== null && typeof json === 'object' ? json as Record<string, unknown> : {}
        const redirect = body[A.RedirectField]
        if (status === A.StatusOk && typeof redirect === 'string')
        {
            return A.Redirecting(redirect)
        }
        const error = body[A.ErrorField]
        const description = body[A.DescriptionField]
        const seconds = retryAfter === null ? Number.NaN : Number(retryAfter)
        return A.Refused(
            typeof error === 'string' ? error : A.Unavailable,
            typeof description === 'string' ? description : undefined,
            Number.isFinite(seconds) && seconds > 0 ? seconds : undefined)
    }
}

// The page's two calls to the realm sign-in service. Injected so tests capture
// the posts without a DOM or a network.
export interface ILoginBackend
{
    // `GET <issuer>/login/config`.
    LoadConfig(): Promise<LoginConfig>

    // `POST <issuer>/login` with `body` as JSON. Never rejects: a failed
    // request answers LoginAnswer.Unavailable.
    Post(body: Readonly<Record<string, string>>): Promise<LoginAnswer>
}

// The browser's same-origin fetch against the page's realm issuer.
export class BrowserLoginBackend implements ILoginBackend
{
    private static readonly GetMethod = 'GET'
    private static readonly PostMethod = 'POST'
    private static readonly SameOrigin = 'same-origin'
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly AcceptHeader = 'Accept'
    private static readonly JsonType = 'application/json'
    private static readonly RetryAfterHeader = 'Retry-After'
    private static readonly ConfigFailedMessage = 'sign-in page config unavailable: '

    private readonly fetchFn: typeof fetch

    public constructor(private readonly location: LoginPageLocation, fetchFn?: typeof fetch)
    {
        this.fetchFn = fetchFn ?? globalThis.fetch.bind(globalThis)
    }

    public async LoadConfig(): Promise<LoginConfig>
    {
        const B = BrowserLoginBackend
        const response = await this.fetchFn(this.location.ConfigPath, {
            method: B.GetMethod,
            credentials: B.SameOrigin,
            headers: { [B.AcceptHeader]: B.JsonType },
        })
        if (!response.ok)
        {
            throw new Error(B.ConfigFailedMessage + String(response.status))
        }
        return LoginConfig.FromJson(await response.json())
    }

    public async Post(body: Readonly<Record<string, string>>): Promise<LoginAnswer>
    {
        const B = BrowserLoginBackend
        try
        {
            const response = await this.fetchFn(this.location.LoginPath, {
                method: B.PostMethod,
                credentials: B.SameOrigin,
                headers: { [B.ContentTypeHeader]: B.JsonType, [B.AcceptHeader]: B.JsonType },
                body: JSON.stringify(body),
            })
            const json: unknown = await response.json().catch(() => null)
            return LoginAnswer.FromResponse(response.status, json, response.headers.get(B.RetryAfterHeader))
        }
        catch
        {
            return LoginAnswer.Refused(LoginAnswer.Unavailable)
        }
    }
}
