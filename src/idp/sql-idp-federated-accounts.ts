import { randomUUID } from 'node:crypto';
import type { ISqlSession, SqlRow } from '@pragmatic-tech-ai/todl';
import { SqlMigrationRunner } from '@pragmatic-tech-ai/pragmatic-realm-adapters';
import { IdpFederatedAccountMigrations } from './tenant-idp-migrations.js';

/** A realm account that signs in through an upstream source: its stable id and what the source last said about it. */
export class FederatedAccount
{
    public constructor(
        public readonly RealmId: string,
        public readonly Source: string,
        public readonly Subject: string,
        public readonly AccountId: string,
        public readonly Email: string,
        public readonly DisplayName: string,
        /** An admin disabled it: it signs in no more, and nothing issued to it still works. */
        public readonly Disabled: boolean)
    {
        Object.freeze(this);
    }
}

/**
 * The link from an upstream identity (source, subject) to the realm account it signs in as, created at the first
 * sign-in. The account id is random and stable (it never changes with the upstream email), so a role mapping naming
 * the account keeps its meaning.
 */
export class SqlIdpFederatedAccounts
{
    private static readonly Columns = 'realm_id, source, subject, account_id, email, display_name, disabled';
    private static readonly FindSql = `SELECT ${SqlIdpFederatedAccounts.Columns} FROM tenant_idp_federated_accounts WHERE realm_id = $1 AND source = $2 AND subject = $3`;
    private static readonly ByAccountSql = `SELECT ${SqlIdpFederatedAccounts.Columns} FROM tenant_idp_federated_accounts WHERE realm_id = $1 AND account_id = $2`;
    private static readonly InsertSql = 'INSERT INTO tenant_idp_federated_accounts (realm_id, source, subject, account_id, email, display_name, created_at, last_sign_in_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $7) ON CONFLICT (realm_id, source, subject) DO NOTHING';
    private static readonly TouchSql = 'UPDATE tenant_idp_federated_accounts SET email = $4, display_name = $5, last_sign_in_at = $6 WHERE realm_id = $1 AND source = $2 AND subject = $3';
    private static readonly ListSql = `SELECT ${SqlIdpFederatedAccounts.Columns} FROM tenant_idp_federated_accounts WHERE realm_id = $1 ORDER BY source, subject`;
    private static readonly DisabledSql = 'UPDATE tenant_idp_federated_accounts SET disabled = $3 WHERE realm_id = $1 AND account_id = $2';
    private static readonly LinkFailedMessage = 'the federated account could not be linked';

    private constructor(private readonly session: ISqlSession)
    {
    }

    public static async Open(session: ISqlSession): Promise<SqlIdpFederatedAccounts>
    {
        await SqlMigrationRunner.Run(session, new IdpFederatedAccountMigrations());
        return new SqlIdpFederatedAccounts(session);
    }

    /** The account the upstream identity signs in as, created at its first sign-in; email and name follow the source. */
    public async Link(realmId: string, source: string, subject: string, email: string, displayName: string, now: Date = new Date()): Promise<FederatedAccount>
    {
        const S = SqlIdpFederatedAccounts;
        if ((await this.Find(realmId, source, subject)) === undefined)
        {
            // A concurrent first sign-in may win the insert; the read below then returns its account.
            await this.session.Execute(S.InsertSql, [realmId, source, subject, randomUUID(), email, displayName, now]);
        }
        await this.session.Execute(S.TouchSql, [realmId, source, subject, email, displayName, now]);
        const linked = await this.Find(realmId, source, subject);
        if (linked === undefined)
        {
            throw new Error(S.LinkFailedMessage);
        }
        return linked;
    }

    public async Find(realmId: string, source: string, subject: string): Promise<FederatedAccount | undefined>
    {
        const rows = await this.session.Query(SqlIdpFederatedAccounts.FindSql, [realmId, source, subject]);
        return rows.length === 0 ? undefined : SqlIdpFederatedAccounts.ToAccount(rows[0]);
    }

    public async ByAccount(realmId: string, accountId: string): Promise<FederatedAccount | undefined>
    {
        const rows = await this.session.Query(SqlIdpFederatedAccounts.ByAccountSql, [realmId, accountId]);
        return rows.length === 0 ? undefined : SqlIdpFederatedAccounts.ToAccount(rows[0]);
    }

    /** Disables or enables the account; false when the realm has no such federated account. */
    public async SetDisabled(realmId: string, accountId: string, disabled: boolean): Promise<boolean>
    {
        return (await this.session.Execute(SqlIdpFederatedAccounts.DisabledSql, [realmId, accountId, disabled])) > 0;
    }

    public async List(realmId: string): Promise<readonly FederatedAccount[]>
    {
        return (await this.session.Query(SqlIdpFederatedAccounts.ListSql, [realmId])).map(row => SqlIdpFederatedAccounts.ToAccount(row));
    }

    private static ToAccount(row: SqlRow): FederatedAccount
    {
        return new FederatedAccount(String(row.realm_id), String(row.source), String(row.subject), String(row.account_id), String(row.email), String(row.display_name), row.disabled === true);
    }
}
