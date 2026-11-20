import type { ISqlSession } from '@pragmatic-tech-ai/todl';
import { SqlMigrationRunner } from '@pragmatic-tech-ai/pragmatic-realm-adapters';
import { IdpAuthorizationCodeMigrations } from './tenant-idp-migrations.js';
import { OpaqueToken } from './opaque-token.js';
import { RealmSignIn } from './realm-sign-in.js';
import { SqlJson } from './sql-json.js';

/** What an authorization code was issued for: the request it answers and the sign-in behind it. */
export class AuthorizationGrant
{
    public constructor(
        public readonly RealmId: string,
        public readonly ClientId: string,
        public readonly RedirectUri: string,
        public readonly Nonce: string,
        public readonly CodeChallenge: string,
        public readonly SignIn: RealmSignIn,
        /** The SSO session the sign-in opened or reused (its refresh tokens end with it). */
        public readonly SsoIdHash: string | undefined)
    {
        Object.freeze(this);
    }

    public ToJson(): Record<string, unknown>
    {
        return {
            clientId: this.ClientId,
            redirectUri: this.RedirectUri,
            nonce: this.Nonce,
            codeChallenge: this.CodeChallenge,
            signIn: this.SignIn.ToJson(),
            ssoIdHash: this.SsoIdHash ?? null,
        };
    }

    public static FromJson(realmId: string, value: unknown): AuthorizationGrant | undefined
    {
        if (value === null || typeof value !== 'object')
        {
            return undefined;
        }
        const json = value as Record<string, unknown>;
        const signIn = RealmSignIn.FromJson(json.signIn);
        if (signIn === undefined || typeof json.clientId !== 'string' || typeof json.redirectUri !== 'string'
            || typeof json.nonce !== 'string' || typeof json.codeChallenge !== 'string')
        {
            return undefined;
        }
        const sso = typeof json.ssoIdHash === 'string' ? json.ssoIdHash : undefined;
        return new AuthorizationGrant(realmId, json.clientId, json.redirectUri, json.nonce, json.codeChallenge, signIn, sso);
    }
}

/** What presenting a code found: its grant (first use), or a replay of a used one and the family it had opened. */
export class CodeRedemption
{
    public static readonly Unknown = new CodeRedemption(undefined, false, undefined);

    public constructor(
        public readonly Grant: AuthorizationGrant | undefined,
        public readonly Replayed: boolean,
        /** The refresh family the code's first use opened (revoked on a replay, RFC 6749 §4.1.2). */
        public readonly ReplayedFamily: string | undefined)
    {
        Object.freeze(this);
    }
}

/**
 * Single-use authorization codes in the service's database: the code is random and stored as its digest; the first
 * use marks it used atomically (one `UPDATE … RETURNING`), so a code works once even across replicas, and an expired
 * one reads as none. A used code stays as a tombstone (with the refresh family it opened) for a while, so a replay is
 * recognised and its family revoked. Issuing sweeps old rows.
 */
export class SqlAuthorizationCodeStore
{
    public static readonly CodeTtlMs = 60 * 1000;
    /** How long a used or expired code is kept to recognise a replay. */
    public static readonly TombstoneMs = 10 * 60 * 1000;
    private static readonly InsertSql = 'INSERT INTO tenant_idp_authorization_codes (code_hash, realm_id, grant_facts, expires_at) VALUES ($1, $2, $3, $4)';
    private static readonly UseSql = 'UPDATE tenant_idp_authorization_codes SET used_at = $2 WHERE code_hash = $1 AND used_at IS NULL RETURNING realm_id, grant_facts, expires_at';
    private static readonly FindSql = 'SELECT used_at, family_id FROM tenant_idp_authorization_codes WHERE code_hash = $1';
    private static readonly FamilySql = 'UPDATE tenant_idp_authorization_codes SET family_id = $2 WHERE code_hash = $1';
    private static readonly SweepSql = 'DELETE FROM tenant_idp_authorization_codes WHERE expires_at <= $1';
    private static readonly NoCode = '';

    private constructor(private readonly session: ISqlSession, private readonly now: () => Date)
    {
    }

    public static async Open(session: ISqlSession, now: () => Date = () => new Date()): Promise<SqlAuthorizationCodeStore>
    {
        await SqlMigrationRunner.Run(session, new IdpAuthorizationCodeMigrations());
        return new SqlAuthorizationCodeStore(session, now);
    }

    public async Issue(grant: AuthorizationGrant): Promise<string>
    {
        const S = SqlAuthorizationCodeStore;
        const now = this.now();
        await this.session.Execute(S.SweepSql, [new Date(now.getTime() - S.TombstoneMs)]);
        const code = OpaqueToken.New();
        await this.session.Execute(S.InsertSql, [OpaqueToken.Hash(code), grant.RealmId, SqlJson.Write(grant.ToJson()), new Date(now.getTime() + S.CodeTtlMs)]);
        return code;
    }

    /** Uses up a live code: its grant; a used code reports the replay and the family its first use opened. */
    public async Take(code: string): Promise<CodeRedemption>
    {
        const S = SqlAuthorizationCodeStore;
        if (code === S.NoCode)
        {
            return CodeRedemption.Unknown;
        }
        const hash = OpaqueToken.Hash(code);
        const rows = await this.session.Query(S.UseSql, [hash, this.now()]);
        if (rows.length === 0)
        {
            const found = await this.session.Query(S.FindSql, [hash]);
            const used = found.length > 0 && found[0].used_at !== null && found[0].used_at !== undefined;
            const family = used && found[0].family_id !== null && found[0].family_id !== undefined ? String(found[0].family_id) : undefined;
            return used ? new CodeRedemption(undefined, true, family) : CodeRedemption.Unknown;
        }
        if (SqlJson.Date(rows[0].expires_at).getTime() <= this.now().getTime())
        {
            return CodeRedemption.Unknown;
        }
        return new CodeRedemption(AuthorizationGrant.FromJson(String(rows[0].realm_id), SqlJson.Read(rows[0].grant_facts)), false, undefined);
    }

    /** Records the refresh family a code's exchange opened (what a replay of the code revokes). */
    public async RecordFamily(code: string, familyId: string): Promise<void>
    {
        await this.session.Execute(SqlAuthorizationCodeStore.FamilySql, [OpaqueToken.Hash(code), familyId]);
    }
}
