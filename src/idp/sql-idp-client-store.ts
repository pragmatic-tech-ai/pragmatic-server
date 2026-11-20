import type { ISqlSession, SqlRow } from '@pragmatic-tech-ai/todl';
import { SqlMigrationRunner } from '@pragmatic-tech-ai/pragmatic-realm-adapters';
import { Argon2PasswordHasher } from '@pragmatic-tech-ai/pragmatic-identity-source-local';
import { IdpClientMigrations } from './tenant-idp-migrations.js';
import { SqlJson } from './sql-json.js';

/** A registered confidential OIDC client of a realm. Holds only the secret's hash, never the secret. */
export class OidcClient
{
    public constructor(
        public readonly ClientId: string,
        public readonly RealmId: string,
        public readonly RedirectUris: readonly string[],
        public readonly PostLogoutRedirectUris: readonly string[],
        public readonly SecretHash: string)
    {
        Object.freeze(this);
    }

    /**
     * Exact string equality against the registered allowlist (no prefix, normalization or query tolerance), plus the
     * RFC 8252 section 7.3 loopback rule: a registered portless http://127.0.0.1 URI matches the identical URI on any
     * port 1-65535.
     */
    public RedirectAllowed(redirectUri: string): boolean
    {
        return this.RedirectUris.includes(redirectUri) || this.RedirectUris.some(registered => LoopbackRedirect.Matches(registered, redirectUri));
    }

    /** A post-logout redirect must be registered as one, or be one of the client's redirect URIs (exactly). */
    public PostLogoutAllowed(uri: string): boolean
    {
        return this.PostLogoutRedirectUris.includes(uri) || this.RedirectUris.includes(uri);
    }
}

/** RFC 8252 section 7.3: the loopback redirect of a native client matches on any port. */
class LoopbackRedirect
{
    private static readonly LoopbackScheme = 'http:';
    private static readonly LoopbackHost = '127.0.0.1';
    private static readonly LoopbackOrigin = 'http://127.0.0.1';
    private static readonly NoPort = '';
    private static readonly PortMark = ':';
    private static readonly QueryMark = '?';
    private static readonly FragmentMark = '#';
    private static readonly MinPort = 1;
    private static readonly MaxPort = 65535;

    public static Matches(registered: string, presented: string): boolean
    {
        const L = LoopbackRedirect;
        if (!registered.startsWith(L.LoopbackOrigin) || presented.includes(L.QueryMark) || presented.includes(L.FragmentMark))
        {
            return false;
        }
        try
        {
            const reg = new URL(registered);
            const pres = new URL(presented);
            if (reg.protocol !== L.LoopbackScheme || reg.hostname !== L.LoopbackHost || reg.port !== L.NoPort || registered.startsWith(L.LoopbackOrigin + L.PortMark))
            {
                return false;
            }
            const port = Number(pres.port);
            if (!Number.isInteger(port) || port < L.MinPort || port > L.MaxPort)
            {
                return false;
            }
            // Byte-identical path: URL parsing would otherwise fold dot segments and escapes into a false match.
            return presented === L.LoopbackOrigin + L.PortMark + pres.port + registered.slice(L.LoopbackOrigin.length);
        }
        catch
        {
            return false;
        }
    }
}

/**
 * The confidential clients of every realm, in the service's database (one row per (realm, client)). Registering again
 * replaces the client (a rotated secret). The secret is kept as its argon2 hash only.
 */
export class SqlIdpClientStore
{
    private static readonly DummySecret = 'idp-client-store-dummy-secret';
    private static readonly Columns = 'realm_id, client_id, redirect_uris, post_logout_redirect_uris, secret_hash';
    private static readonly UpsertSql = `INSERT INTO tenant_idp_clients (${SqlIdpClientStore.Columns}, updated_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (realm_id, client_id) DO UPDATE SET redirect_uris = EXCLUDED.redirect_uris, post_logout_redirect_uris = EXCLUDED.post_logout_redirect_uris, secret_hash = EXCLUDED.secret_hash, updated_at = EXCLUDED.updated_at`;
    /** The importer never replaces a client registered since. */
    private static readonly RestoreSql = `INSERT INTO tenant_idp_clients (${SqlIdpClientStore.Columns}, updated_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (realm_id, client_id) DO NOTHING`;
    private static readonly FindSql = `SELECT ${SqlIdpClientStore.Columns} FROM tenant_idp_clients WHERE realm_id = $1 AND client_id = $2`;
    private static readonly ListSql = `SELECT ${SqlIdpClientStore.Columns} FROM tenant_idp_clients WHERE realm_id = $1 ORDER BY client_id`;
    private static readonly DeleteSql = 'DELETE FROM tenant_idp_clients WHERE realm_id = $1 AND client_id = $2';

    private readonly hasher = new Argon2PasswordHasher();
    private readonly dummyHash: Promise<string>;

    private constructor(private readonly session: ISqlSession)
    {
        this.dummyHash = this.hasher.Hash(SqlIdpClientStore.DummySecret);
    }

    public static async Open(session: ISqlSession): Promise<SqlIdpClientStore>
    {
        await SqlMigrationRunner.Run(session, new IdpClientMigrations());
        return new SqlIdpClientStore(session);
    }

    /** Registers (or replaces) the client; true when it replaced one whose secret was different (a rotation, after
     *  which what was issued under the old secret should end). */
    public async Register(realmId: string, clientId: string, redirectUris: readonly string[], secret: string, postLogoutRedirectUris: readonly string[] = []): Promise<boolean>
    {
        const existing = await this.Find(realmId, clientId);
        const rotated = existing !== undefined && !(await this.hasher.Verify(secret, existing.SecretHash));
        const hash = await this.hasher.Hash(secret);
        await this.session.Execute(SqlIdpClientStore.UpsertSql, [realmId, clientId, SqlJson.Write([...redirectUris]), SqlJson.Write([...postLogoutRedirectUris]), hash, new Date()]);
        return rotated;
    }

    /** Writes a client with an existing secret hash (the importer of pre-A5 registrations). */
    public async Restore(realmId: string, clientId: string, redirectUris: readonly string[], secretHash: string): Promise<void>
    {
        await this.session.Execute(SqlIdpClientStore.RestoreSql, [realmId, clientId, SqlJson.Write([...redirectUris]), SqlJson.Write([]), secretHash, new Date()]);
    }

    public async Find(realmId: string, clientId: string): Promise<OidcClient | undefined>
    {
        const rows = await this.session.Query(SqlIdpClientStore.FindSql, [realmId, clientId]);
        return rows.length === 0 ? undefined : SqlIdpClientStore.ToClient(rows[0]);
    }

    public async List(realmId: string): Promise<readonly OidcClient[]>
    {
        return (await this.session.Query(SqlIdpClientStore.ListSql, [realmId])).map(row => SqlIdpClientStore.ToClient(row));
    }

    /** Removes the client; returns whether it existed. */
    public async Remove(realmId: string, clientId: string): Promise<boolean>
    {
        return (await this.session.Execute(SqlIdpClientStore.DeleteSql, [realmId, clientId])) > 0;
    }

    /** The client when the secret matches; an unknown client costs the same argon2 verify as a wrong secret. */
    public async Authenticate(realmId: string, clientId: string, presented: string): Promise<OidcClient | undefined>
    {
        const client = clientId === '' ? undefined : await this.Find(realmId, clientId);
        if (client === undefined)
        {
            await this.hasher.Verify(presented, await this.dummyHash);
            return undefined;
        }
        return await this.hasher.Verify(presented, client.SecretHash) ? client : undefined;
    }

    private static ToClient(row: SqlRow): OidcClient
    {
        return new OidcClient(String(row.client_id), String(row.realm_id), SqlJson.Strings(row.redirect_uris), SqlJson.Strings(row.post_logout_redirect_uris), String(row.secret_hash));
    }
}
