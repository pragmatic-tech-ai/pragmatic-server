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

/**
 * Single-use authorization codes in the service's database: the code is random, stored as its digest, and taken
 * atomically (one `DELETE … RETURNING`), so a code works once even across replicas; an expired code is consumed and
 * reads as none. Issuing sweeps expired codes.
 */
export class SqlAuthorizationCodeStore
{
    public static readonly CodeTtlMs = 60 * 1000;
    private static readonly InsertSql = 'INSERT INTO tenant_idp_authorization_codes (code_hash, realm_id, grant_facts, expires_at) VALUES ($1, $2, $3, $4)';
    private static readonly TakeSql = 'DELETE FROM tenant_idp_authorization_codes WHERE code_hash = $1 RETURNING realm_id, grant_facts, expires_at';
    private static readonly SweepSql = 'DELETE FROM tenant_idp_authorization_codes WHERE expires_at <= $1';

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
        const now = this.now();
        await this.session.Execute(SqlAuthorizationCodeStore.SweepSql, [now]);
        const code = OpaqueToken.New();
        await this.session.Execute(SqlAuthorizationCodeStore.InsertSql, [OpaqueToken.Hash(code), grant.RealmId, SqlJson.Write(grant.ToJson()), new Date(now.getTime() + SqlAuthorizationCodeStore.CodeTtlMs)]);
        return code;
    }

    /** The grant of a live code, consuming it; undefined for an unknown, used or expired one. */
    public async Take(code: string): Promise<AuthorizationGrant | undefined>
    {
        if (code === '')
        {
            return undefined;
        }
        const rows = await this.session.Query(SqlAuthorizationCodeStore.TakeSql, [OpaqueToken.Hash(code)]);
        if (rows.length === 0 || SqlJson.Date(rows[0].expires_at).getTime() <= this.now().getTime())
        {
            return undefined;
        }
        return AuthorizationGrant.FromJson(String(rows[0].realm_id), SqlJson.Read(rows[0].grant_facts));
    }
}
