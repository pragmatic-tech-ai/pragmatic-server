import { SessionPolicy, SessionRecord, SessionStore } from '@pragmatic-tech-ai/pragmatic-app-host'
import type { OperatorPrincipal } from '../operator-identity.js'
import { OperatorRoleClaims, OperatorSessions, type OperatorSessionOptions, type OperatorSessionRepositories } from '../operator-sessions.js'

/**
 * The console's session layer in memory, with sessions planted under fixed tokens, so a host test can send a known
 * `cp_session` cookie. A planted session is what PasswordLoginEndpoint would have issued for the principal (subject =
 * principal id, claims = email + role); the console's gate still refreshes the role from the operator identity on every
 * request.
 */
export class HostSessions
{
    public readonly Repositories: OperatorSessionRepositories
    public readonly Sessions: OperatorSessions

    public constructor(secureCookie: boolean = false, options: OperatorSessionOptions = {})
    {
        this.Repositories = OperatorSessions.InMemory(options.Tickets?.Now ?? Date.now)
        this.Sessions = new OperatorSessions(this.Repositories, secureCookie, options)
    }

    /** The session layer with `token` planted for `principal`. */
    public static async With(token: string, principal: OperatorPrincipal, secureCookie: boolean = false, options: OperatorSessionOptions = {}): Promise<HostSessions>
    {
        const sessions = new HostSessions(secureCookie, options)
        await sessions.Seed(token, principal)
        return sessions
    }

    /** Plants a live session (one hour) under `token` for `principal`. */
    public async Seed(token: string, principal: OperatorPrincipal): Promise<void>
    {
        const now = new Date()
        const record = new SessionRecord(SessionStore.DigestOf(token), principal.principalId, OperatorRoleClaims.Of(principal), now,
            new Date(now.getTime() + OperatorSessions.TtlMs), now, new SessionPolicy(OperatorSessions.TtlMs))
        await this.Repositories.Sessions.Insert(record)
    }

    /** Ends the token's session (as a logout elsewhere would). */
    public async Revoke(token: string): Promise<void>
    {
        await this.Sessions.Store.Revoke(token)
    }

    /** Whether the token still names a live session. */
    public async IsLive(token: string): Promise<boolean>
    {
        return (await this.Sessions.Store.Validate(token)) !== null
    }

    /** The session id (the token digest) a token is stored under: what the socket registry is keyed by. */
    public static IdOf(token: string): string
    {
        return SessionStore.DigestOf(token)
    }
}
