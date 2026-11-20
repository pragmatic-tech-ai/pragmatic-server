import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import { OperatorIdentity, type OperatorPrincipal } from '../operator-identity.js'
import { OperatorRoleClaims, OperatorSessions, type OperatorSessionGate } from '../operator-sessions.js'

/**
 * An operator identity over a console database with its session layer in memory, signing in and validating the way the
 * console does: Verify then the session store's Issue; the session store's Validate then the gate's refresh.
 */
export class OperatorHarness
{
    private static readonly KeyFile = 'master.key'

    public readonly Gate: OperatorSessionGate

    private constructor(public readonly Identity: OperatorIdentity, public readonly Sessions: OperatorSessions)
    {
        this.Gate = Sessions.GateOver(Identity)
    }

    /** Composes over `session`, with the master key file in `root` (created on first use). */
    public static async Compose(root: string, session: ISqlSession, operatorEmail: string, initialPassword: string | undefined, sessions: OperatorSessions = new OperatorSessions(OperatorSessions.InMemory(), false)): Promise<OperatorHarness>
    {
        const identity = await OperatorIdentity.Compose({ session, masterKeyFile: join(root, OperatorHarness.KeyFile), operatorEmail, initialPassword, sessions: sessions.Store })
        return new OperatorHarness(identity, sessions)
    }

    public static KeyFileIn(root: string): string
    {
        return join(root, OperatorHarness.KeyFile)
    }

    /** Runs `body` with a fresh temporary folder, removed afterwards. */
    public static async WithRoot(prefix: string, body: (root: string) => Promise<void>): Promise<void>
    {
        const root = mkdtempSync(join(tmpdir(), prefix))
        try
        {
            await body(root)
        }
        finally
        {
            rmSync(root, { recursive: true, force: true })
        }
    }

    /** The console's password sign-in: a session token when the password is right, else null. */
    public async SignIn(email: string, password: string): Promise<{ token: string } | null>
    {
        const principal = await this.Identity.Verify(email, password)
        if (principal === null)
        {
            return null
        }
        const issued = await this.Sessions.Store.Issue(principal.principalId, OperatorRoleClaims.Of(principal))
        return { token: issued.Token }
    }

    /** Who the token's session is now, as the console's gate answers it; null when it names no live session. */
    public async Validate(token: string): Promise<OperatorPrincipal | null>
    {
        const session = await this.Sessions.Store.Validate(token)
        const refreshed = session === null ? null : await this.Gate.Refreshed(session)
        return refreshed === null ? null : OperatorRoleClaims.PrincipalOf(refreshed)
    }

    public async SignOut(token: string): Promise<void>
    {
        await this.Sessions.Store.Revoke(token)
    }
}
