import type { ISqlSession } from '@pragmatic-tech-ai/todl';
import { SqlMigrationRunner } from '@pragmatic-tech-ai/pragmatic-realm-adapters';
import { IdpSsoSessionMigrations } from './tenant-idp-migrations.js';
import { OpaqueToken } from './opaque-token.js';
import { RealmSignIn } from './realm-sign-in.js';
import { SqlJson } from './sql-json.js';

/** A live single sign-on session of the login domain: the sign-in it remembers and its id digest. */
export class SsoSession
{
    public constructor(
        public readonly IdHash: string,
        public readonly RealmId: string,
        public readonly SignIn: RealmSignIn,
        public readonly ExpiresAt: Date)
    {
        Object.freeze(this);
    }
}

/**
 * The login domain's single sign-on sessions, in the service's database: the cookie carries a random id, the row its
 * digest and the sign-in it remembers (so a silent re-authentication resolves roles exactly as the first sign-in), each
 * bound to one realm. Ending a session (logout, a password change, an admin reset) is a row delete.
 */
export class SqlSsoSessionStore
{
    private static readonly InsertSql = 'INSERT INTO tenant_idp_sso_sessions (id_hash, realm_id, account_id, sign_in, expires_at) VALUES ($1, $2, $3, $4, $5)';
    private static readonly GetSql = 'SELECT realm_id, sign_in, expires_at FROM tenant_idp_sso_sessions WHERE id_hash = $1';
    private static readonly DeleteSql = 'DELETE FROM tenant_idp_sso_sessions WHERE id_hash = $1';
    private static readonly DeleteAccountSql = 'DELETE FROM tenant_idp_sso_sessions WHERE realm_id = $1 AND account_id = $2 AND id_hash <> $3';
    private static readonly SweepSql = 'DELETE FROM tenant_idp_sso_sessions WHERE expires_at <= $1';
    private static readonly NoHash = '';

    private constructor(private readonly session: ISqlSession, private readonly now: () => Date)
    {
    }

    public static async Open(session: ISqlSession, now: () => Date = () => new Date()): Promise<SqlSsoSessionStore>
    {
        await SqlMigrationRunner.Run(session, new IdpSsoSessionMigrations());
        return new SqlSsoSessionStore(session, now);
    }

    /** A new session; the returned id goes into the cookie (and nowhere else). */
    public async Issue(realmId: string, signIn: RealmSignIn, lifetimeMs: number): Promise<{ Id: string; Session: SsoSession }>
    {
        const now = this.now();
        await this.session.Execute(SqlSsoSessionStore.SweepSql, [now]);
        const id = OpaqueToken.New();
        const idHash = OpaqueToken.Hash(id);
        const expiresAt = new Date(now.getTime() + lifetimeMs);
        await this.session.Execute(SqlSsoSessionStore.InsertSql, [idHash, realmId, signIn.AccountId, SqlJson.Write(signIn.ToJson()), expiresAt]);
        return { Id: id, Session: new SsoSession(idHash, realmId, signIn, expiresAt) };
    }

    /** The realm's live session for a cookie id; undefined when unknown, expired or of another realm. */
    public async Validate(id: string, realmId: string): Promise<SsoSession | undefined>
    {
        if (id === '')
        {
            return undefined;
        }
        const idHash = OpaqueToken.Hash(id);
        const rows = await this.session.Query(SqlSsoSessionStore.GetSql, [idHash]);
        if (rows.length === 0)
        {
            return undefined;
        }
        const expiresAt = SqlJson.Date(rows[0].expires_at);
        if (expiresAt.getTime() <= this.now().getTime())
        {
            await this.session.Execute(SqlSsoSessionStore.DeleteSql, [idHash]);
            return undefined;
        }
        const signIn = RealmSignIn.FromJson(SqlJson.Read(rows[0].sign_in));
        if (String(rows[0].realm_id) !== realmId || signIn === undefined)
        {
            return undefined;
        }
        return new SsoSession(idHash, realmId, signIn, expiresAt);
    }

    /** Whether the session (by id digest) is still live: not ended by a logout or a reset, not expired. */
    public async Exists(idHash: string): Promise<boolean>
    {
        const rows = await this.session.Query(SqlSsoSessionStore.GetSql, [idHash]);
        return rows.length > 0 && SqlJson.Date(rows[0].expires_at).getTime() > this.now().getTime();
    }

    public async Revoke(idHash: string): Promise<void>
    {
        await this.session.Execute(SqlSsoSessionStore.DeleteSql, [idHash]);
    }

    /** Ends every session of the account in the realm except `keepIdHash`; returns how many ended. */
    public async RevokeAccount(realmId: string, accountId: string, keepIdHash: string = SqlSsoSessionStore.NoHash): Promise<number>
    {
        return await this.session.Execute(SqlSsoSessionStore.DeleteAccountSql, [realmId, accountId, keepIdHash]);
    }
}
