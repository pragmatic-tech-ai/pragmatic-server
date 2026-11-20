import {
    InMemorySessionRepository,
    InMemoryThrottleRepository,
    InMemoryTicketRepository,
    LoginThrottle,
    RateLimiter,
    SessionClaims,
    SessionCookie,
    SessionPolicy,
    SessionRecord,
    SessionStore,
    WsTicketStore,
    type IssuedSession,
    type ISessionRepository,
    type IThrottleRepository,
    type ITicketRepository,
    type LoginThrottleOptions,
    type SignedInIdentity,
    type WsTicketStoreOptions,
} from '@pragmatic-tech-ai/pragmatic-app-host'

/** What a session authenticates: a console cookie, or the Plexus desktop bearer. A session without a kind is a Console one. */
export enum TenantSessionKind
{
    Console = 'console',
    Desktop = 'desktop',
}

/**
 * A tenant-plane session as the console's routes see it: the app-host session's id (the token digest, a non-secret
 * handle), the tenant and principal it belongs to, its email, expiry and kind, and the roles it holds (the tenant roles
 * of the `roles` claim, this application's roles of `app_roles`). Never carries the token.
 */
export type TenantSession = {
    id: string
    tenantId: string
    principalId: string
    email?: string
    expiresAt: string
    issuedAt?: string
    kind?: TenantSessionKind
    roles?: readonly string[]
    appRoles?: readonly string[]
}

/** The claim names of a tenant-plane session: the one home of how a session names its tenant, email, kind and roles. */
export class TenantSessionClaims
{
    /** The tenant whose realm signed the subject in (a fixed claim of the console's OIDC client). */
    public static readonly TenantClaim = 'tenant'
    public static readonly EmailClaim = 'email'
    /** Present (`desktop`) only on a desktop bearer session. */
    public static readonly KindClaim = 'kind'
    /** The tenant roles (stage B: `admin`), as the realm issues them and the console's bridge adds them. */
    public static readonly RolesClaim = 'roles'
    /** This application's roles by bare name (`environment-admin`). */
    public static readonly AppRolesClaim = 'app_roles'

    /** The tenant a session record names, or undefined when it carries none (not a tenant-plane session). */
    public static TenantOf(record: SessionRecord): string | undefined
    {
        return record.Claims.First(TenantSessionClaims.TenantClaim)
    }

    public static KindOf(record: SessionRecord): TenantSessionKind
    {
        return record.Claims.First(TenantSessionClaims.KindClaim) === TenantSessionKind.Desktop ? TenantSessionKind.Desktop : TenantSessionKind.Console
    }

    /** The routes' view of a tenant-plane session record; undefined when it names no tenant. */
    public static ViewOf(record: SessionRecord): TenantSession | undefined
    {
        const C = TenantSessionClaims
        const tenantId = C.TenantOf(record)
        if (tenantId === undefined)
        {
            return undefined
        }
        const view: TenantSession = {
            id: record.Id,
            tenantId,
            principalId: record.Subject,
            expiresAt: record.ExpiresAt.toISOString(),
            issuedAt: record.IssuedAt.toISOString(),
            roles: [...record.Claims.Values(C.RolesClaim)],
            appRoles: [...record.Claims.Values(C.AppRolesClaim)],
        }
        const email = record.Claims.First(C.EmailClaim)
        if (email !== undefined)
        {
            view.email = email
        }
        if (C.KindOf(record) === TenantSessionKind.Desktop)
        {
            view.kind = TenantSessionKind.Desktop
        }
        return view
    }

    /** The claims of a session of `tenantId` for `email` (tests, the importer and the desktop sign-in build them so). */
    public static Of(tenantId: string, email: string | undefined, kind: TenantSessionKind = TenantSessionKind.Console): SessionClaims
    {
        const C = TenantSessionClaims
        const values: Record<string, string | readonly string[]> = { [C.TenantClaim]: tenantId }
        if (email !== undefined)
        {
            values[C.EmailClaim] = email
        }
        if (kind === TenantSessionKind.Desktop)
        {
            values[C.KindClaim] = TenantSessionKind.Desktop
        }
        return SessionClaims.From(values)
    }

    /** The record with its claims replaced (a gate's refreshed roles). */
    public static WithClaims(record: SessionRecord, claims: SessionClaims): SessionRecord
    {
        return new SessionRecord(record.Id, record.Subject, claims, record.IssuedAt, record.ExpiresAt, record.KeptAt, record.Policy)
    }
}

/** Overrides of the session layer's defaults (tests: a clock, short ticket lifetimes, a tighter throttle). */
export interface TenantSessionOptions
{
    readonly Tickets?: WsTicketStoreOptions
    readonly Login?: LoginThrottleOptions
    readonly Now?: () => Date
    /** The clock of the desktop begin limiter (ms). */
    readonly NowMs?: () => number
    /** The desktop sessions' lifetime from issue and from each renewal (default DesktopTtlMs). */
    readonly DesktopTtlMs?: number
}

/** Where the console's session state lives: the sessions, the WebSocket tickets and the throttles (Postgres in
 *  production, memory in tests). */
export interface TenantSessionRepositories
{
    readonly Sessions: ISessionRepository
    readonly Tickets: ITicketRepository
    readonly Throttles: IThrottleRepository
}

/**
 * The tenant console's session layer over one set of repositories: the session store (console sessions fixed 12 hours,
 * desktop sessions sliding 7 days, renewed at most hourly, never past 30 days), the `pts_session` cookie (the token
 * alone), the socket tickets, the desktop sign-in throttle, the desktop begin limiter and the host's denial limiter.
 */
export class TenantSessions
{
    /** A console session lives 12 hours from sign-in (it does not slide). */
    public static readonly ConsoleTtlMs = 12 * 60 * 60 * 1000
    /** How long a desktop session lives from issue and from each renewal. */
    public static readonly DesktopTtlMs = 7 * 24 * 60 * 60 * 1000
    /** A desktop session is renewed at most once per this interval of use. */
    public static readonly DesktopRenewalIntervalMs = 60 * 60 * 1000
    /** A desktop session never lives past this long after it was issued, however often it is used. */
    public static readonly DesktopMaxLifetimeMs = 30 * 24 * 60 * 60 * 1000
    /** The console's cookie name (unchanged; it now carries the token alone). */
    public static readonly CookieName = 'pts_session'
    /** The desktop begin limit: 10 begins per minute per address, then locked for a minute. */
    public static readonly MaxBeginsPerWindow = 10
    public static readonly BeginWindowMs = 60 * 1000
    private static readonly BeginName = 'tenant-desktop-begin'
    private static readonly DenialName = 'tenant-denials'
    private static readonly DesktopLoginName = 'tenant-desktop-login'
    private static readonly DenialMaxHits = 30
    private static readonly DenialWindowMs = 60_000
    private static readonly DenialLockoutMs = 60_000

    public static readonly ConsolePolicy = new SessionPolicy(TenantSessions.ConsoleTtlMs)

    public readonly Store: SessionStore
    /** How a desktop session lives (sliding; see the class comment). */
    public readonly DesktopPolicy: SessionPolicy
    public readonly Cookie: SessionCookie
    public readonly Tickets: WsTicketStore
    /** Failed desktop sign-in completes per address. */
    public readonly LoginThrottle: LoginThrottle
    /** Desktop sign-in begins per address (each costs an IdP registration and a flow slot). */
    public readonly Begins: RateLimiter
    /** The host's denial limiter over the same (persistent) throttle repository. */
    public readonly Denials: RateLimiter

    public constructor(repositories: TenantSessionRepositories, secureCookie: boolean, options: TenantSessionOptions = {})
    {
        const S = TenantSessions
        this.Store = new SessionStore(repositories.Sessions, S.ConsolePolicy, options.Now)
        this.DesktopPolicy = new SessionPolicy(options.DesktopTtlMs ?? S.DesktopTtlMs, S.DesktopRenewalIntervalMs, S.DesktopMaxLifetimeMs)
        this.Cookie = new SessionCookie({ Name: S.CookieName, Secure: secureCookie })
        this.Tickets = new WsTicketStore(repositories.Tickets, options.Tickets)
        this.LoginThrottle = new LoginThrottle(repositories.Throttles, { Name: S.DesktopLoginName, ...options.Login })
        this.Begins = new RateLimiter(repositories.Throttles, { Name: S.BeginName, MaxHits: S.MaxBeginsPerWindow, WindowMs: S.BeginWindowMs, LockoutMs: S.BeginWindowMs, Now: options.NowMs })
        this.Denials = new RateLimiter(repositories.Throttles, { Name: S.DenialName, MaxHits: S.DenialMaxHits, WindowMs: S.DenialWindowMs, LockoutMs: S.DenialLockoutMs })
    }

    /** A desktop bearer session for a completed desktop sign-in (the claims gain `kind: desktop`). */
    public IssueDesktop(identity: SignedInIdentity): Promise<IssuedSession>
    {
        const claims = identity.Claims.With(TenantSessionClaims.KindClaim, [TenantSessionKind.Desktop])
        return this.Store.Issue(identity.Subject, claims, this.DesktopPolicy)
    }

    /** Process-local repositories: tests and tools that keep nothing (`now`: the tickets' and throttles' clock). */
    public static InMemory(now: () => number = Date.now): TenantSessionRepositories
    {
        return { Sessions: new InMemorySessionRepository(), Tickets: new InMemoryTicketRepository(undefined, now), Throttles: new InMemoryThrottleRepository(undefined, now) }
    }
}
