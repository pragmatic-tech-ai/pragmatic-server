import type { ISqlSession } from '@pragmatic-tech-ai/todl';
import { SqlMigrationRunner } from '@pragmatic-tech-ai/pragmatic-realm-adapters';
import { IdpAccountProfileMigrations } from './tenant-idp-migrations.js';
import { SqlJson } from './sql-json.js';

/**
 * What the service keeps beside a local account (the identity stores hold email and password hash): its display name
 * and when its credentials last changed (anything authenticated before that no longer counts). Holds no email or secret.
 */
export class SqlIdpAccountProfiles
{
    private static readonly NameSql = 'INSERT INTO tenant_idp_account_profiles (realm_id, account_id, display_name) VALUES ($1, $2, $3) ON CONFLICT (realm_id, account_id) DO UPDATE SET display_name = EXCLUDED.display_name';
    private static readonly ChangedInsertSql = 'INSERT INTO tenant_idp_account_profiles (realm_id, account_id, display_name, credentials_changed_at) VALUES ($1, $2, $3, $4) ON CONFLICT (realm_id, account_id) DO UPDATE SET credentials_changed_at = EXCLUDED.credentials_changed_at';
    private static readonly GetSql = 'SELECT display_name, credentials_changed_at FROM tenant_idp_account_profiles WHERE realm_id = $1 AND account_id = $2';
    private static readonly NoName = '';

    private constructor(private readonly session: ISqlSession)
    {
    }

    public static async Open(session: ISqlSession): Promise<SqlIdpAccountProfiles>
    {
        await SqlMigrationRunner.Run(session, new IdpAccountProfileMigrations());
        return new SqlIdpAccountProfiles(session);
    }

    public async PutName(realmId: string, accountId: string, displayName: string): Promise<void>
    {
        await this.session.Execute(SqlIdpAccountProfiles.NameSql, [realmId, accountId, displayName]);
    }

    public async Name(realmId: string, accountId: string): Promise<string | undefined>
    {
        const rows = await this.session.Query(SqlIdpAccountProfiles.GetSql, [realmId, accountId]);
        return rows.length === 0 ? undefined : String(rows[0].display_name);
    }

    public async StampCredentialsChanged(realmId: string, accountId: string, at: Date): Promise<void>
    {
        await this.session.Execute(SqlIdpAccountProfiles.ChangedInsertSql, [realmId, accountId, SqlIdpAccountProfiles.NoName, at]);
    }

    public async CredentialsChangedAt(realmId: string, accountId: string): Promise<Date | undefined>
    {
        const rows = await this.session.Query(SqlIdpAccountProfiles.GetSql, [realmId, accountId]);
        const value = rows.length === 0 ? null : rows[0].credentials_changed_at;
        return value === null || value === undefined ? undefined : SqlJson.Date(value);
    }
}
