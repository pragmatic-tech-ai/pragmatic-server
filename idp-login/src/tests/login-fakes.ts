import { IdentityPlatformPageConfig, IdentityPlatformProvider } from '@pragmatic-tech-ai/pragmatic-identity-source-identity-platform/client'
import { FederatedRoundTrip, type IRoundTripStorage } from '../federated-round-trip.js'
import { IdpLoginViewModel } from '../idp-login-view-model.js'
import { LoginAnswer, type ILoginBackend } from '../login-backend.js'
import { LoginConfig, LoginSource } from '../login-config.js'
import { LoginPageLocation } from '../login-page-location.js'
import type { IPageNavigator } from '../page-navigator.js'

// One scripted answer of FakeFetch.
export type FakeReply = { status: number; json: unknown; headers?: Record<string, string> }

// A fetch that answers by the endpoint the URL ends with (before its query) and records every call.
export class FakeFetch
{
    public readonly Calls: Array<{ url: string; endpoint: string; body: Record<string, unknown> }> = []
    private readonly replies = new Map<string, Array<FakeReply>>()

    public Reply(endpoint: string, reply: FakeReply): this
    {
        const queue = this.replies.get(endpoint) ?? []
        queue.push(reply)
        this.replies.set(endpoint, queue)
        return this
    }

    public Ok(endpoint: string, json: unknown): this
    {
        return this.Reply(endpoint, { status: 200, json })
    }

    public Error(endpoint: string, code: string): this
    {
        return this.Reply(endpoint, { status: 400, json: { error: { code: 400, message: code } } })
    }

    public Endpoints(): string[]
    {
        return this.Calls.map(call => call.endpoint)
    }

    public readonly Fetch: typeof fetch = async (input, init) =>
    {
        const url = new URL(String(input))
        const endpoint = url.pathname.slice(url.pathname.lastIndexOf('/') + 1)
        this.Calls.push({ url: url.href, endpoint, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
        const queue = this.replies.get(endpoint) ?? []
        const reply = queue.length > 1 ? queue.shift()! : queue[0]
        if (reply === undefined)
        {
            throw new TypeError('no reply scripted for ' + endpoint)
        }
        return new Response(JSON.stringify(reply.json), { status: reply.status, headers: reply.headers })
    }
}

// Records posts; answers each with the next scripted answer (default: a redirect).
export class FakeBackend implements ILoginBackend
{
    public static readonly DoneUrl = 'https://app.test/cb?code=c1'
    public readonly Posts: Array<Record<string, string>> = []
    public readonly Answers: LoginAnswer[] = []
    public Loads = 0

    public constructor(public Config: LoginConfig | undefined)
    {
    }

    public async LoadConfig(): Promise<LoginConfig>
    {
        this.Loads++
        if (this.Config === undefined)
        {
            throw new Error('config unavailable')
        }
        return this.Config
    }

    public async Post(body: Readonly<Record<string, string>>): Promise<LoginAnswer>
    {
        this.Posts.push({ ...body })
        return this.Answers.shift() ?? LoginAnswer.Redirecting(FakeBackend.DoneUrl)
    }
}

export class FakeNavigator implements IPageNavigator
{
    public readonly Visits: string[] = []

    public Assign(url: string): void
    {
        this.Visits.push(url)
    }
}

export class MemoryStorage implements IRoundTripStorage
{
    public readonly Items = new Map<string, string>()

    public getItem(key: string): string | null
    {
        return this.Items.get(key) ?? null
    }

    public setItem(key: string, value: string): void
    {
        this.Items.set(key, value)
    }

    public removeItem(key: string): void
    {
        this.Items.delete(key)
    }
}

// Builds page view models over the fakes.
export class LoginFixture
{
    public static readonly Origin = 'https://login.test'
    public static readonly AuthorizePath = '/realms/central/protocol/openid-connect/auth'
    public static readonly ContinuePath = '/__/auth/handler'
    public static readonly Request = 'response_type=code&client_id=c1&redirect_uri=https%3A%2F%2Fapp.test%2Fcb&state=s1&code_challenge=x&code_challenge_method=S256'
    public static readonly ApiKey = 'browser-key'

    public readonly Backend: FakeBackend
    public readonly Navigator = new FakeNavigator()
    public readonly Storage: MemoryStorage
    public readonly Ip = new FakeFetch()
    public readonly Page: IdpLoginViewModel

    public constructor(config: LoginConfig | undefined, request: string = LoginFixture.Request, storage: MemoryStorage = new MemoryStorage(), failed = false)
    {
        this.Backend = new FakeBackend(config)
        this.Storage = storage
        const location = LoginPageLocation.From(LoginFixture.Origin, LoginFixture.AuthorizePath, '?' + request)
        this.Page = new IdpLoginViewModel(this.Backend, this.Navigator, location, new FederatedRoundTrip(storage), this.Ip.Fetch, failed)
    }

    public static Local(sources: LoginSource[] = []): LoginConfig
    {
        return new LoginConfig('central', 'Central', true, sources, null, false)
    }

    public static Platform(providers: IdentityPlatformProvider[], signUp = true, local = false, tenantId: string | null = null): LoginConfig
    {
        const page = new IdentityPlatformPageConfig('proj', LoginFixture.ApiKey, 'proj.firebaseapp.com', providers, tenantId)
        return new LoginConfig('central', 'Central', local, [], page, signUp)
    }

    public static async Loaded(config: LoginConfig | undefined, request?: string): Promise<LoginFixture>
    {
        const fixture = new LoginFixture(config, request)
        await fixture.Page.Load()
        return fixture
    }

    // Lets fire-and-forget command work (promise chains) settle.
    public static async Settle(): Promise<void>
    {
        for (let i = 0; i < 20; i++)
        {
            await new Promise<void>(done => setImmediate(done))
        }
    }
}
