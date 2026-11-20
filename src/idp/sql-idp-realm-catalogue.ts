import type { ISqlSession } from '@pragmatic-tech-ai/todl';
import { SqlMigrationRunner } from '@pragmatic-tech-ai/pragmatic-realm-adapters';
import { IdpRealmCatalogueMigrations } from './tenant-idp-migrations.js';

/** A realm the service serves: its id and display name. */
export class CatalogueEntry
{
    public constructor(public readonly RealmId: string, public readonly DisplayName: string)
    {
        Object.freeze(this);
    }
}

/**
 * The realms the service serves (created through the admin API, or named by a configuration at start), so a restart
 * reopens every one. Recording again replaces the display name.
 */
export class SqlIdpRealmCatalogue
{
    private static readonly UpsertSql = 'INSERT INTO tenant_idp_realms (realm_id, display_name, created_at) VALUES ($1, $2, $3) ON CONFLICT (realm_id) DO UPDATE SET display_name = EXCLUDED.display_name';
    private static readonly ListSql = 'SELECT realm_id, display_name FROM tenant_idp_realms ORDER BY realm_id';

    private constructor(private readonly session: ISqlSession)
    {
    }

    public static async Open(session: ISqlSession): Promise<SqlIdpRealmCatalogue>
    {
        await SqlMigrationRunner.Run(session, new IdpRealmCatalogueMigrations());
        return new SqlIdpRealmCatalogue(session);
    }

    public async Record(realmId: string, displayName: string): Promise<void>
    {
        await this.session.Execute(SqlIdpRealmCatalogue.UpsertSql, [realmId, displayName, new Date()]);
    }

    public async Entries(): Promise<readonly CatalogueEntry[]>
    {
        return (await this.session.Query(SqlIdpRealmCatalogue.ListSql, [])).map(row => new CatalogueEntry(String(row.realm_id), String(row.display_name)));
    }
}
