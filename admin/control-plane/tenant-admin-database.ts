import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import { PgSession, SqlOidcFlowStateStore, SqlSecretKeyRing, SqlSecretStore } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { PostgresPoolFactory } from '@pragmatic-tech-ai/pragmatic-realm-custom'
import { SqlAuditRepository, SqlSessionRepository, SqlThrottleRepository, SqlTicketRepository } from '@pragmatic-tech-ai/pragmatic-app-host'
import { SqlConfigurationRepository } from '@pragmatic-tech-ai/pragmatic-configuration'
import { SqlRecordMap } from './sql-record-map.js'
import type { TenantSessionRepositories } from './tenant-auth/tenant-sessions.js'

/** The record registries of the tenant admin console, each one `records_<name>` table of its database. */
export enum TenantAdminRegistry
{
    Environments = 'environments',
    TenantAdminClients = 'tenant_admin_clients',
    DesktopAudit = 'desktop_audit',
    GraphAudit = 'graph_audit',
    EmailDomains = 'console_email_domains',
    Registration = 'console_registration',
    OwnerResetApplied = 'owner_reset_applied',
    DirectorySeed = 'directory_seed',
    VerifiedImages = 'verified_images',
    /** The completion record of the one-time import of a pre-A5 data root (written last, in the import's transaction). */
    ImportState = 'tenant_admin_import',
}

/** The database URL setting is missing or blank (the console stores everything in its own Postgres). */
export class TenantAdminDatabaseMissingError extends Error
{
    private static readonly ErrorName = 'TenantAdminDatabaseMissingError'
    private static readonly Text = 'PRAGMATIC_TENANT_ADMIN_DATABASE_URL_FILE must name the file holding the tenant admin console database URL'

    public constructor()
    {
        super(TenantAdminDatabaseMissingError.Text)
        this.name = TenantAdminDatabaseMissingError.ErrorName
    }
}

/**
 * The tenant admin console's own Postgres database (A5): one URL, read from the secret file
 * PRAGMATIC_TENANT_ADMIN_DATABASE_URL_FILE, and every store over it: a record map per registry, the session repositories
 * (sessions, WebSocket tickets, throttles), the audit trail, the OIDC flow state, the sealed secrets (the OIDC client
 * secrets, under the master key) and the configuration repository. Opening a store runs its migrations.
 */
export class TenantAdminDatabase
{
    public static readonly UrlFileEnvVar = 'PRAGMATIC_TENANT_ADMIN_DATABASE_URL_FILE'
    /** The sealed-secret scope of the console's own secrets (the OIDC relying-party client secrets). */
    public static readonly SecretScope = 'tenant-admin'
    /** The key id the master key seals under. */
    public static readonly SecretKeyId = 'master'
    private static readonly ApplicationName = 'pragmatic-tenant-admin'
    /** How long a start waits for its database to answer (the in-hive console's Postgres sidecar starts beside it). */
    public static readonly ReadyTimeoutMs = 60_000
    private static readonly ReadyPollMs = 1_000
    private static readonly ProbeSql = 'SELECT 1'
    private static readonly NoParams: readonly unknown[] = []

    private constructor(public readonly Session: ISqlSession, private readonly owned: PgSession | undefined)
    {
    }

    /**
     * Opens the database the environment names (the URL file is read here; its content is never logged) and waits until it
     * answers, at most `readyTimeoutMs` (a pod's Postgres sidecar may still be starting); the last connection error is
     * rethrown when it never does.
     */
    public static async Open(env: NodeJS.ProcessEnv, readyTimeoutMs: number = TenantAdminDatabase.ReadyTimeoutMs): Promise<TenantAdminDatabase>
    {
        const D = TenantAdminDatabase
        const urlFile = env[D.UrlFileEnvVar]?.trim() ?? ''
        if (urlFile === '')
        {
            throw new TenantAdminDatabaseMissingError()
        }
        const pool = await new PostgresPoolFactory({ UrlFile: urlFile, ApplicationName: D.ApplicationName }).Create()
        const session = new PgSession(pool)
        const deadline = Date.now() + readyTimeoutMs
        for (;;)
        {
            try
            {
                await session.Query(D.ProbeSql, D.NoParams)
                return new TenantAdminDatabase(session, session)
            }
            catch (err)
            {
                if (Date.now() + D.ReadyPollMs > deadline)
                {
                    await session.Dispose()
                    throw err
                }
                await new Promise<void>(resolve => setTimeout(resolve, D.ReadyPollMs))
            }
        }
    }

    /** Over a session the caller owns (tests, the importer's target). */
    public static Over(session: ISqlSession): TenantAdminDatabase
    {
        return new TenantAdminDatabase(session, undefined)
    }

    public Map<T>(registry: TenantAdminRegistry): Promise<SqlRecordMap<T>>
    {
        return SqlRecordMap.Open<T>(this.Session, registry)
    }

    public async SessionRepositories(): Promise<TenantSessionRepositories>
    {
        return {
            Sessions: await SqlSessionRepository.Open(this.Session),
            Tickets: await SqlTicketRepository.Open(this.Session),
            Throttles: await SqlThrottleRepository.Open(this.Session),
        }
    }

    /** The audit trail of the console's routes. */
    public Audit(): Promise<SqlAuditRepository>
    {
        return SqlAuditRepository.Open(this.Session)
    }

    /** The pending OIDC sign-ins (state, nonce, PKCE verifier), so a sign-in begun on one replica completes on another. */
    public FlowStates(): Promise<SqlOidcFlowStateStore>
    {
        return SqlOidcFlowStateStore.Open(this.Session)
    }

    /** The console's sealed secrets (AES-256-GCM under the master key, scope `tenant-admin`). */
    public Secrets(masterKey: Buffer): Promise<SqlSecretStore>
    {
        return SqlSecretStore.Open(this.Session, SqlSecretKeyRing.Single(TenantAdminDatabase.SecretKeyId, masterKey), TenantAdminDatabase.SecretScope)
    }

    /** The configuration repository of the components this console runs. */
    public Configuration(): Promise<SqlConfigurationRepository>
    {
        return SqlConfigurationRepository.Open(this.Session)
    }

    /** Ends the pool when this database opened it. */
    public async Close(): Promise<void>
    {
        await this.owned?.Dispose()
    }
}
