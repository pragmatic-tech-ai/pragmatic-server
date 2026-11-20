import type { IncomingMessage } from 'node:http'
import {
    InMemorySessionRepository,
    InMemoryThrottleRepository,
    InMemoryTicketRepository,
    LoginThrottle,
    RateLimiter,
    SessionClaims,
    SessionCookie,
    SessionGate,
    SessionPolicy,
    SessionRecord,
    SessionStore,
    SignedInIdentity,
    WsTicketStore,
    type IPasswordAuthenticator,
    type ISessionRepository,
    type IThrottleRepository,
    type ITicketRepository,
    type LoginThrottleOptions,
    type WsTicketStoreOptions,
} from '@pragmatic-tech-ai/pragmatic-app-host'
import { OperatorRole, type IOperatorIdentity, type OperatorPrincipal } from './operator-identity.js'

/**
 * The operator roles as session claims: the platform admin console's application roles (declared in its component
 * descriptor), carried in the `app_roles` claim beside the operator's `email`. ClaimsAuthorizer checks a route's role
 * against `app_roles`.
 */
export class OperatorRoleClaims
{
    /** The console's application role that may change the platform (an Owner grant on the operator realm). */
    public static readonly Full = 'operator.full'
    /** The console's application role that may only observe (a Viewer grant, or no Owner grant). */
    public static readonly ReadOnly = 'operator.read-only'
    /** Both roles: what a route open to every operator names. */
    public static readonly Any: readonly string[] = [OperatorRoleClaims.Full, OperatorRoleClaims.ReadOnly]
    /** The claim the roles travel in (the application-roles claim of the realm's sessions). */
    public static readonly RoleClaim = 'app_roles'
    public static readonly EmailClaim = 'email'

    public static NameOf(role: OperatorRole): string
    {
        return role === OperatorRole.Full ? OperatorRoleClaims.Full : OperatorRoleClaims.ReadOnly
    }

    /** The session claims of an operator: its email and its role. */
    public static Of(principal: OperatorPrincipal): SessionClaims
    {
        return SessionClaims.From({ [OperatorRoleClaims.EmailClaim]: principal.email, [OperatorRoleClaims.RoleClaim]: [OperatorRoleClaims.NameOf(principal.role)] })
    }

    /** The operator a session names: its subject, email and role (ReadOnly unless the claims say Full: deny by default). */
    public static PrincipalOf(session: SessionRecord): OperatorPrincipal
    {
        const role = session.Claims.Has(OperatorRoleClaims.RoleClaim, OperatorRoleClaims.Full) ? OperatorRole.Full : OperatorRole.ReadOnly
        return { email: session.Claims.First(OperatorRoleClaims.EmailClaim) ?? session.Subject, principalId: session.Subject, role }
    }
}

/**
 * The authentication step of the platform admin console: the cookie's session from the session store, with its claims
 * refreshed from the operator's account on every request, so a demotion, a promotion or a disabled account takes effect
 * at once (as the identity-pack sessions did) while the role still reaches authorization as a claim.
 */
export class OperatorSessionGate extends SessionGate
{
    public constructor(sessions: SessionStore, cookie: SessionCookie, private readonly operators: IOperatorIdentity)
    {
        super(sessions, cookie)
    }

    public override async Current(req: IncomingMessage): Promise<SessionRecord | null>
    {
        const session = await super.Current(req)
        return session === null ? null : await this.Refreshed(session)
    }

    /** The session with its claims as the operator's account says now; null when the operator is gone or disabled. */
    public async Refreshed(session: SessionRecord): Promise<SessionRecord | null>
    {
        const principal = await this.operators.PrincipalOf(session.Subject)
        if (principal === null)
        {
            return null
        }
        return new SessionRecord(session.Id, session.Subject, OperatorRoleClaims.Of(principal), session.IssuedAt, session.ExpiresAt, session.KeptAt, session.Policy)
    }
}

/** The break-glass password sign-in of PasswordLoginEndpoint over the operator accounts. */
export class OperatorPasswordAuthenticator implements IPasswordAuthenticator
{
    public constructor(private readonly operators: IOperatorIdentity)
    {
    }

    public async Authenticate(account: string, password: string): Promise<SignedInIdentity | null>
    {
        const principal = await this.operators.Verify(account, password)
        return principal === null ? null : new SignedInIdentity(principal.principalId, OperatorRoleClaims.Of(principal))
    }
}

/** Overrides of the session layer's defaults (tests: a clock, short ticket lifetimes, a tighter throttle). */
export interface OperatorSessionOptions
{
    readonly Tickets?: WsTicketStoreOptions
    readonly Login?: LoginThrottleOptions
    readonly Now?: () => Date
}

/** Where the console's session state lives: the sessions, the WebSocket tickets and the throttles (Postgres in
 *  production, memory in tests). */
export interface OperatorSessionRepositories
{
    readonly Sessions: ISessionRepository
    readonly Tickets: ITicketRepository
    readonly Throttles: IThrottleRepository
}

/**
 * The operator session layer of the platform admin console: the session store (one hour from sign-in, as before), the
 * `cp_session` cookie, the event-socket tickets, the sign-in throttle and the denial limiter, over one set of repositories.
 */
export class OperatorSessions
{
    /** An operator session lives one hour from sign-in (it does not slide). */
    public static readonly TtlMs = 60 * 60 * 1000
    /** The console's cookie name (unchanged from the identity-pack sessions). */
    public static readonly CookieName = 'cp_session'
    /** Refused unauthenticated mutations per client address: 30 a minute, then a minute locked (the host's default). */
    private static readonly DenialName = 'denials'
    private static readonly DenialMaxHits = 30
    private static readonly DenialWindowMs = 60_000
    private static readonly DenialLockoutMs = 60_000

    public readonly Store: SessionStore
    public readonly Cookie: SessionCookie
    public readonly Tickets: WsTicketStore
    public readonly LoginThrottle: LoginThrottle
    /** The host's denial limiter over the same (persistent) throttle repository. */
    public readonly Denials: RateLimiter

    /** The operator identity ends sessions through Store, so the layer exists before the identity; GateOver joins them. */
    public constructor(repositories: OperatorSessionRepositories, secureCookie: boolean, options: OperatorSessionOptions = {})
    {
        this.Store = new SessionStore(repositories.Sessions, new SessionPolicy(OperatorSessions.TtlMs), options.Now)
        this.Cookie = new SessionCookie({ Name: OperatorSessions.CookieName, Secure: secureCookie })
        this.Tickets = new WsTicketStore(repositories.Tickets, options.Tickets)
        this.LoginThrottle = new LoginThrottle(repositories.Throttles, options.Login)
        const S = OperatorSessions
        this.Denials = new RateLimiter(repositories.Throttles, { Name: S.DenialName, MaxHits: S.DenialMaxHits, WindowMs: S.DenialWindowMs, LockoutMs: S.DenialLockoutMs })
    }

    /** The authentication step over these sessions, refreshing each session's claims from `operators`. */
    public GateOver(operators: IOperatorIdentity): OperatorSessionGate
    {
        return new OperatorSessionGate(this.Store, this.Cookie, operators)
    }

    /** Process-local repositories: tests and tools that keep nothing (`now`: the tickets' and throttles' clock). */
    public static InMemory(now: () => number = Date.now): OperatorSessionRepositories
    {
        return { Sessions: new InMemorySessionRepository(), Tickets: new InMemoryTicketRepository(undefined, now), Throttles: new InMemoryThrottleRepository(undefined, now) }
    }
}
