import { randomUUID } from 'node:crypto';
import type { ISqlSession, SqlRow } from '@pragmatic-tech-ai/todl';
import { SqlMigrationRunner } from '@pragmatic-tech-ai/pragmatic-realm-adapters';
import { IdpRefreshTokenMigrations } from './tenant-idp-migrations.js';
import { OpaqueToken } from './opaque-token.js';
import { RealmSignIn } from './realm-sign-in.js';
import { SqlJson } from './sql-json.js';
import type { TokenPolicy } from './realm-settings.js';

/** A redeemed refresh token: its family (every token rotated from one sign-in) and what it was issued for. */
export class RefreshGrant
{
    public constructor(
        public readonly FamilyId: string,
        public readonly RealmId: string,
        public readonly ClientId: string,
        public readonly SignIn: RealmSignIn,
        public readonly SsoIdHash: string | undefined,
        public readonly FamilyExpiresAt: Date)
    {
        Object.freeze(this);
    }
}

/** How a presented refresh token fared. */
export enum RefreshOutcome
{
    /** Live and now used: rotate it. */
    Redeemed = 'redeemed',
    /** Unknown, expired, revoked or another client's. */
    Invalid = 'invalid',
    /** Already used once: a stolen copy or a replay; the whole family is revoked. */
    Reused = 'reused',
}

/**
 * Rotating, revocable refresh tokens for confidential clients (RFC 6749 §6, OAuth 2.0 Security BCP §4.14): each token
 * is random and stored as its digest; a refresh uses it up in one atomic update and issues the next token of the same
 * family; a token presented a second time revokes its family (reuse detection). A token lives for the realm's idle
 * lifetime, a family no longer than the maximum lifetime from the sign-in. Families end with their SSO session
 * (logout), with the account (password change, admin reset) or on revocation (RFC 7009).
 */
export class SqlRefreshTokenStore
{
    private static readonly Columns = 'family_id, realm_id, client_id, sso_id_hash, sign_in, family_expires_at';
    /** Inserts the next token of a family unless the family is revoked (a reuse detected while this refresh ran). */
    private static readonly InsertSql = 'INSERT INTO tenant_idp_refresh_tokens (token_hash, family_id, realm_id, client_id, account_id, sso_id_hash, sign_in, issued_at, expires_at, family_expires_at) SELECT $1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::jsonb, $8::timestamptz, $9::timestamptz, $10::timestamptz WHERE NOT EXISTS (SELECT 1 FROM tenant_idp_refresh_tokens WHERE family_id = $2 AND revoked_at IS NOT NULL)';
    private static readonly UseSql = `UPDATE tenant_idp_refresh_tokens SET used_at = $2 WHERE token_hash = $1 AND realm_id = $3 AND client_id = $4 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > $2 AND family_expires_at > $2 RETURNING ${SqlRefreshTokenStore.Columns}`;
    private static readonly FindSql = 'SELECT family_id, realm_id, client_id, used_at, revoked_at FROM tenant_idp_refresh_tokens WHERE token_hash = $1';
    private static readonly RevokeFamilySql = 'UPDATE tenant_idp_refresh_tokens SET revoked_at = $2 WHERE family_id = $1 AND revoked_at IS NULL';
    private static readonly RevokeSsoSql = 'UPDATE tenant_idp_refresh_tokens SET revoked_at = $2 WHERE sso_id_hash = $1 AND revoked_at IS NULL';
    private static readonly RevokeAccountSql = 'UPDATE tenant_idp_refresh_tokens SET revoked_at = $3 WHERE realm_id = $1 AND account_id = $2 AND revoked_at IS NULL';
    private static readonly RevokeClientSql = 'UPDATE tenant_idp_refresh_tokens SET revoked_at = $3 WHERE realm_id = $1 AND client_id = $2 AND revoked_at IS NULL';
    private static readonly NoToken = '';
    private static readonly SweepSql = 'DELETE FROM tenant_idp_refresh_tokens WHERE family_expires_at <= $1';

    private constructor(private readonly session: ISqlSession, private readonly now: () => Date)
    {
    }

    public static async Open(session: ISqlSession, now: () => Date = () => new Date()): Promise<SqlRefreshTokenStore>
    {
        await SqlMigrationRunner.Run(session, new IdpRefreshTokenMigrations());
        return new SqlRefreshTokenStore(session, now);
    }

    /** The first token of a new family, for a sign-in just exchanged at the token endpoint; the family lives at most
     *  `familyMs` from now. */
    public async IssueFamily(realmId: string, clientId: string, signIn: RealmSignIn, ssoIdHash: string | undefined, policy: TokenPolicy, familyMs: number): Promise<{ Token: string; FamilyId: string }>
    {
        const now = this.now();
        await this.session.Execute(SqlRefreshTokenStore.SweepSql, [now]);
        const familyId = randomUUID();
        const token = await this.Insert(familyId, realmId, clientId, signIn, ssoIdHash, new Date(now.getTime() + familyMs), policy, now);
        return { Token: token ?? SqlRefreshTokenStore.NoToken, FamilyId: familyId };
    }

    /** The next token of a redeemed one's family (never past the family's end); undefined when the family was revoked
     *  meanwhile (a reuse detected while this refresh ran). */
    public async Rotate(grant: RefreshGrant, signIn: RealmSignIn, policy: TokenPolicy): Promise<string | undefined>
    {
        return await this.Insert(grant.FamilyId, grant.RealmId, grant.ClientId, signIn, grant.SsoIdHash, grant.FamilyExpiresAt, policy, this.now());
    }

    /** Uses up a live token of the client in the realm; a second use of one revokes its family. */
    public async Redeem(token: string, realmId: string, clientId: string): Promise<{ Outcome: RefreshOutcome; Grant?: RefreshGrant }>
    {
        const S = SqlRefreshTokenStore;
        if (token === S.NoToken)
        {
            return { Outcome: RefreshOutcome.Invalid };
        }
        const hash = OpaqueToken.Hash(token);
        const now = this.now();
        const rows = await this.session.Query(S.UseSql, [hash, now, realmId, clientId]);
        if (rows.length > 0)
        {
            const grant = S.ToGrant(rows[0]);
            return grant === undefined ? { Outcome: RefreshOutcome.Invalid } : { Outcome: RefreshOutcome.Redeemed, Grant: grant };
        }
        const found = await this.session.Query(S.FindSql, [hash]);
        if (found.length > 0 && String(found[0].realm_id) === realmId && String(found[0].client_id) === clientId
            && found[0].used_at !== null && found[0].revoked_at === null)
        {
            await this.RevokeFamily(String(found[0].family_id));
            return { Outcome: RefreshOutcome.Reused };
        }
        return { Outcome: RefreshOutcome.Invalid };
    }

    /** RFC 7009: revokes the family of the client's token; true when the token was the client's. */
    public async RevokeToken(token: string, realmId: string, clientId: string): Promise<boolean>
    {
        if (token === SqlRefreshTokenStore.NoToken)
        {
            return false;
        }
        const found = await this.session.Query(SqlRefreshTokenStore.FindSql, [OpaqueToken.Hash(token)]);
        if (found.length === 0 || String(found[0].realm_id) !== realmId || String(found[0].client_id) !== clientId)
        {
            return false;
        }
        await this.RevokeFamily(String(found[0].family_id));
        return true;
    }

    public async RevokeFamily(familyId: string): Promise<void>
    {
        await this.session.Execute(SqlRefreshTokenStore.RevokeFamilySql, [familyId, this.now()]);
    }

    /** Ends every family issued under the SSO session (its logout). */
    public async RevokeSso(ssoIdHash: string): Promise<void>
    {
        await this.session.Execute(SqlRefreshTokenStore.RevokeSsoSql, [ssoIdHash, this.now()]);
    }

    /** Ends every family of the account (its password changed, an admin reset). */
    public async RevokeAccount(realmId: string, accountId: string): Promise<void>
    {
        await this.session.Execute(SqlRefreshTokenStore.RevokeAccountSql, [realmId, accountId, this.now()]);
    }

    /** Ends every family of a client (it was removed or re-registered). */
    public async RevokeClient(realmId: string, clientId: string): Promise<void>
    {
        await this.session.Execute(SqlRefreshTokenStore.RevokeClientSql, [realmId, clientId, this.now()]);
    }

    private async Insert(familyId: string, realmId: string, clientId: string, signIn: RealmSignIn, ssoIdHash: string | undefined, familyExpiresAt: Date, policy: TokenPolicy, now: Date): Promise<string | undefined>
    {
        const token = OpaqueToken.New();
        const expiresAt = new Date(Math.min(now.getTime() + policy.RefreshIdleMs, familyExpiresAt.getTime()));
        const inserted = await this.session.Execute(SqlRefreshTokenStore.InsertSql, [OpaqueToken.Hash(token), familyId, realmId, clientId, signIn.AccountId, ssoIdHash ?? null, SqlJson.Write(signIn.ToJson()), now, expiresAt, familyExpiresAt]);
        return inserted > 0 ? token : undefined;
    }

    private static ToGrant(row: SqlRow): RefreshGrant | undefined
    {
        const signIn = RealmSignIn.FromJson(SqlJson.Read(row.sign_in));
        if (signIn === undefined)
        {
            return undefined;
        }
        const sso = row.sso_id_hash === null || row.sso_id_hash === undefined ? undefined : String(row.sso_id_hash);
        return new RefreshGrant(String(row.family_id), String(row.realm_id), String(row.client_id), signIn, sso, SqlJson.Date(row.family_expires_at));
    }
}
