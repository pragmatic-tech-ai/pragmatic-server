import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import { PgSession, SqlOidcFlowStateStore, SqlSecretKeyRing, SqlSecretStore } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { PostgresPoolFactory } from '@pragmatic-tech-ai/pragmatic-realm-custom'
import { SqlAuditRepository, SqlSessionRepository, SqlThrottleRepository, SqlTicketRepository } from '@pragmatic-tech-ai/pragmatic-app-host'
import { SqlRecordMap } from './sql-record-map.js'
import { SqlSignatureStore } from './sql-signature-store.js'
import type { OperatorSessionRepositories } from './operator-sessions.js'

/** The record registries of the platform admin console, each one `records_<name>` table of its database. */
export enum PlatformAdminRegistry
{
    Clients = 'clients',
    Tenants = 'tenants',
    Hives = 'hives',
    Environments = 'environments',
    Idps = 'idps',
    Manifests = 'manifests',
    Gating = 'gating',
    Selections = 'selections',
    HiveObservations = 'hive_observations',
    RolloutRegistrations = 'rollout_registrations',
    ReleasePolicies = 'release_policies',
    AdoptionLedger = 'adoption_ledger',
    DesktopAudit = 'desktop_audit',
    GraphAudit = 'graph_audit',
    TenantAdminClients = 'tenant_admin_clients',
    TenantAccounts = 'tenant_accounts',
    ConsoleAdverts = 'console_adverts',
    ConsoleDomainApprovals = 'console_domain_approvals',
    ConsoleOwnerResets = 'console_owner_resets',
    SealedSecrets = 'sealed_secrets',
    Signatures = 'signatures',
}

/** The database URL setting is missing or blank (the console stores everything in its own Postgres). */
export class PlatformAdminDatabaseMissingError extends Error
{
    private static readonly ErrorName = 'PlatformAdminDatabaseMissingError'
    private static readonly Text = 'PRAGMATIC_ADMIN_DATABASE_URL_FILE must name the file holding the platform admin console database URL'

    public constructor()
    {
        super(PlatformAdminDatabaseMissingError.Text)
        this.name = PlatformAdminDatabaseMissingError.ErrorName
    }
}

/**
 * The platform admin console's own Postgres database (A5): one URL, read from the secret file PRAGMATIC_ADMIN_DATABASE_URL_FILE,
 * and every store over it: a record map per registry, the signature store, the operator session repositories (sessions,
 * WebSocket tickets, throttles; shared with the co-hosted tenant plane, whose gate refuses operator sessions and the
 * operator gate tenant ones), the operator audit trail, the operator identity stores, and the co-hosted tenant plane's
 * OIDC flow state and sealed client secrets. Opening a store runs its migrations. The edge never opens it.
 */
export class PlatformAdminDatabase
{
    public static readonly UrlFileEnvVar = 'PRAGMATIC_ADMIN_DATABASE_URL_FILE'
    private static readonly ApplicationName = 'pragmatic-platform-admin'
    /** The sealed-secret scope of the co-hosted tenant plane (the operator identity seals under `control-plane`). */
    public static readonly TenantPlaneSecretScope = 'tenant-admin'
    private static readonly SecretKeyId = 'master'

    private constructor(public readonly Session: ISqlSession, private readonly owned: PgSession | undefined)
    {
    }

    /** Opens the database the environment names (the URL file is read here; its content is never logged). */
    public static async Open(env: NodeJS.ProcessEnv): Promise<PlatformAdminDatabase>
    {
        const urlFile = env[PlatformAdminDatabase.UrlFileEnvVar]?.trim() ?? ''
        if (urlFile === '')
        {
            throw new PlatformAdminDatabaseMissingError()
        }
        const pool = await new PostgresPoolFactory({ UrlFile: urlFile, ApplicationName: PlatformAdminDatabase.ApplicationName }).Create()
        const session = new PgSession(pool)
        return new PlatformAdminDatabase(session, session)
    }

    /** Over a session the caller owns (tests, the importer's target). */
    public static Over(session: ISqlSession): PlatformAdminDatabase
    {
        return new PlatformAdminDatabase(session, undefined)
    }

    public Map<T>(registry: PlatformAdminRegistry): Promise<SqlRecordMap<T>>
    {
        return SqlRecordMap.Open<T>(this.Session, registry)
    }

    public Signatures(): Promise<SqlSignatureStore>
    {
        return SqlSignatureStore.Open(this.Session)
    }

    public async SessionRepositories(): Promise<OperatorSessionRepositories>
    {
        return {
            Sessions: await SqlSessionRepository.Open(this.Session),
            Tickets: await SqlTicketRepository.Open(this.Session),
            Throttles: await SqlThrottleRepository.Open(this.Session),
        }
    }

    /** The pending OIDC sign-ins of the co-hosted tenant plane (state, nonce, PKCE verifier). */
    public FlowStates(): Promise<SqlOidcFlowStateStore>
    {
        return SqlOidcFlowStateStore.Open(this.Session)
    }

    /** The co-hosted tenant plane's sealed secrets (its OIDC client secrets; scope `tenant-admin`, under the master key). */
    public TenantPlaneSecrets(masterKey: Buffer): Promise<SqlSecretStore>
    {
        return SqlSecretStore.Open(this.Session, SqlSecretKeyRing.Single(PlatformAdminDatabase.SecretKeyId, masterKey), PlatformAdminDatabase.TenantPlaneSecretScope)
    }

    /** The operator audit trail (the activity log). */
    public Audit(): Promise<SqlAuditRepository>
    {
        return SqlAuditRepository.Open(this.Session)
    }

    /** Ends the pool when this database opened it. */
    public async Close(): Promise<void>
    {
        await this.owned?.Dispose()
    }
}
