import type { ISqlSession } from '@pragmatic-tech-ai/todl';
import { PgSession, SqlApplicationCatalogue, SqlAuditStore, SqlLocalAccountStore, SqlOidcFlowStateStore, SqlRoleMappingStore, SqlSecretKeyRing, SqlSecretStore } from '@pragmatic-tech-ai/pragmatic-realm-adapters';
import { PostgresPoolFactory } from '@pragmatic-tech-ai/pragmatic-realm-custom';
import { SqlAuditRepository, SqlThrottleRepository } from '@pragmatic-tech-ai/pragmatic-app-host';
import { SqlIdpClientStore } from './sql-idp-client-store.js';
import { SqlIdpRealmCatalogue } from './sql-idp-realm-catalogue.js';
import { SqlIdpAccountProfiles } from './sql-idp-account-profiles.js';
import { SqlIdpFederatedAccounts } from './sql-idp-federated-accounts.js';
import { SqlAuthorizationCodeStore } from './sql-authorization-code-store.js';
import { SqlSsoSessionStore } from './sql-sso-session-store.js';
import { SqlRefreshTokenStore } from './sql-refresh-token-store.js';

/** The database URL setting is missing or blank (the service stores everything in its own Postgres). */
export class TenantIdpDatabaseMissingError extends Error
{
    private static readonly ErrorName = 'TenantIdpDatabaseMissingError';
    private static readonly Text = 'PRAGMATIC_IDP_DATABASE_URL_FILE must name the file holding the realm sign-in service database URL';

    public constructor()
    {
        super(TenantIdpDatabaseMissingError.Text);
        this.name = TenantIdpDatabaseMissingError.ErrorName;
    }
}

/** Every store of the service, opened over its database (each Open ran its migrations). */
export class TenantIdpStores
{
    public constructor(
        public readonly Accounts: SqlLocalAccountStore,
        public readonly Audit: SqlAuditStore,
        public readonly RoleMappings: SqlRoleMappingStore,
        public readonly Applications: SqlApplicationCatalogue,
        public readonly FlowStates: SqlOidcFlowStateStore,
        public readonly Throttles: SqlThrottleRepository,
        public readonly HostAudit: SqlAuditRepository,
        public readonly Clients: SqlIdpClientStore,
        public readonly Realms: SqlIdpRealmCatalogue,
        public readonly Profiles: SqlIdpAccountProfiles,
        public readonly Federated: SqlIdpFederatedAccounts,
        public readonly Codes: SqlAuthorizationCodeStore,
        public readonly Sso: SqlSsoSessionStore,
        public readonly RefreshTokens: SqlRefreshTokenStore)
    {
        Object.freeze(this);
    }
}

/**
 * The realm sign-in service's own Postgres database (A5): one URL, read from the secret file
 * PRAGMATIC_IDP_DATABASE_URL_FILE (its content is never logged), and every store over it: the identity stores (local
 * accounts, the authentication audit), each realm's sealed secrets (password hashes and the realm's configuration
 * secrets, under the master key), role mappings and the application catalogue, the pending upstream sign-ins, the
 * throttles and the admin audit, and the service's own tables (clients, realms, profiles, federated accounts,
 * authorization codes, SSO sessions, refresh tokens).
 */
export class TenantIdpDatabase
{
    public static readonly UrlFileEnvVar = 'PRAGMATIC_IDP_DATABASE_URL_FILE';
    /** The key id the master key seals under. */
    public static readonly SecretKeyId = 'master';
    /** The sealed-secret scope of a realm: `tenant-idp/<realm>`. */
    public static readonly SecretScopePrefix = 'tenant-idp/';
    private static readonly ApplicationName = 'pragmatic-tenant-idp';
    /** How long a start waits for its database to answer (a pod's Postgres sidecar starts beside it). */
    public static readonly ReadyTimeoutMs = 60_000;
    private static readonly ReadyPollMs = 1_000;
    private static readonly ProbeSql = 'SELECT 1';
    private static readonly NoParams: readonly unknown[] = [];

    private constructor(public readonly Session: ISqlSession, private readonly owned: PgSession | undefined)
    {
    }

    /** Opens the database the environment names and waits until it answers (at most `readyTimeoutMs`). */
    public static async Open(env: NodeJS.ProcessEnv, readyTimeoutMs: number = TenantIdpDatabase.ReadyTimeoutMs): Promise<TenantIdpDatabase>
    {
        const D = TenantIdpDatabase;
        const urlFile = env[D.UrlFileEnvVar]?.trim() ?? '';
        if (urlFile === '')
        {
            throw new TenantIdpDatabaseMissingError();
        }
        const pool = await new PostgresPoolFactory({ UrlFile: urlFile, ApplicationName: D.ApplicationName }).Create();
        const session = new PgSession(pool);
        const deadline = Date.now() + readyTimeoutMs;
        for (;;)
        {
            try
            {
                await session.Query(D.ProbeSql, D.NoParams);
                return new TenantIdpDatabase(session, session);
            }
            catch (err)
            {
                if (Date.now() + D.ReadyPollMs > deadline)
                {
                    await session.Dispose();
                    throw err;
                }
                await new Promise<void>(resolve => setTimeout(resolve, D.ReadyPollMs));
            }
        }
    }

    /** Over a session the caller owns (tests, the importer's target). */
    public static Over(session: ISqlSession): TenantIdpDatabase
    {
        return new TenantIdpDatabase(session, undefined);
    }

    public async Stores(now: () => Date = () => new Date()): Promise<TenantIdpStores>
    {
        const s = this.Session;
        return new TenantIdpStores(
            await SqlLocalAccountStore.Open(s),
            await SqlAuditStore.Open(s),
            await SqlRoleMappingStore.Open(s),
            await SqlApplicationCatalogue.Open(s),
            await SqlOidcFlowStateStore.Open(s, now),
            await SqlThrottleRepository.Open(s),
            await SqlAuditRepository.Open(s),
            await SqlIdpClientStore.Open(s),
            await SqlIdpRealmCatalogue.Open(s),
            await SqlIdpAccountProfiles.Open(s),
            await SqlIdpFederatedAccounts.Open(s),
            await SqlAuthorizationCodeStore.Open(s, now),
            await SqlSsoSessionStore.Open(s, now),
            await SqlRefreshTokenStore.Open(s, now));
    }

    /** A realm's sealed secrets (AES-256-GCM under the master key, scope `tenant-idp/<realm>`). */
    public RealmSecrets(realmId: string, masterKey: Buffer): Promise<SqlSecretStore>
    {
        return SqlSecretStore.Open(this.Session, SqlSecretKeyRing.Single(TenantIdpDatabase.SecretKeyId, masterKey), TenantIdpDatabase.SecretScopePrefix + realmId);
    }

    /** Ends the pool when this database opened it. */
    public async Close(): Promise<void>
    {
        await this.owned?.Dispose();
    }
}
