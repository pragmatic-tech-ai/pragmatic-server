import { SqlMigration, SqlMigrationModule } from '@pragmatic-tech-ai/pragmatic-realm-adapters';

/** The schema history of the realm sign-in service's own tables: one module per store, frozen literal SQL per step. */
export class IdpClientMigrations extends SqlMigrationModule
{
    private static readonly V1 = new SqlMigration(1, [
        'CREATE TABLE tenant_idp_clients (realm_id text NOT NULL, client_id text NOT NULL, redirect_uris jsonb NOT NULL, post_logout_redirect_uris jsonb NOT NULL, secret_hash text NOT NULL, updated_at timestamptz NOT NULL, PRIMARY KEY (realm_id, client_id))',
    ]);

    public readonly Name = 'tenant_idp.clients';

    public Migrations(): readonly SqlMigration[]
    {
        return [IdpClientMigrations.V1];
    }
}

export class IdpRealmCatalogueMigrations extends SqlMigrationModule
{
    private static readonly V1 = new SqlMigration(1, [
        'CREATE TABLE tenant_idp_realms (realm_id text PRIMARY KEY, display_name text NOT NULL, created_at timestamptz NOT NULL)',
    ]);

    public readonly Name = 'tenant_idp.realms';

    public Migrations(): readonly SqlMigration[]
    {
        return [IdpRealmCatalogueMigrations.V1];
    }
}

export class IdpAccountProfileMigrations extends SqlMigrationModule
{
    private static readonly V1 = new SqlMigration(1, [
        'CREATE TABLE tenant_idp_account_profiles (realm_id text NOT NULL, account_id text NOT NULL, display_name text NOT NULL, credentials_changed_at timestamptz, PRIMARY KEY (realm_id, account_id))',
    ]);

    public readonly Name = 'tenant_idp.account_profiles';

    public Migrations(): readonly SqlMigration[]
    {
        return [IdpAccountProfileMigrations.V1];
    }
}

export class IdpFederatedAccountMigrations extends SqlMigrationModule
{
    private static readonly V1 = new SqlMigration(1, [
        'CREATE TABLE tenant_idp_federated_accounts (realm_id text NOT NULL, source text NOT NULL, subject text NOT NULL, account_id text NOT NULL, email text NOT NULL, display_name text NOT NULL, created_at timestamptz NOT NULL, last_sign_in_at timestamptz NOT NULL, disabled boolean NOT NULL DEFAULT false, PRIMARY KEY (realm_id, source, subject))',
        'CREATE UNIQUE INDEX tenant_idp_federated_accounts_account ON tenant_idp_federated_accounts (realm_id, account_id)',
    ]);

    public readonly Name = 'tenant_idp.federated_accounts';

    public Migrations(): readonly SqlMigration[]
    {
        return [IdpFederatedAccountMigrations.V1];
    }
}

export class IdpAuthorizationCodeMigrations extends SqlMigrationModule
{
    private static readonly V1 = new SqlMigration(1, [
        'CREATE TABLE tenant_idp_authorization_codes (code_hash text PRIMARY KEY, realm_id text NOT NULL, grant_facts jsonb NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz, family_id text)',
        'CREATE INDEX tenant_idp_authorization_codes_expires ON tenant_idp_authorization_codes (expires_at)',
    ]);

    public readonly Name = 'tenant_idp.authorization_codes';

    public Migrations(): readonly SqlMigration[]
    {
        return [IdpAuthorizationCodeMigrations.V1];
    }
}

export class IdpSsoSessionMigrations extends SqlMigrationModule
{
    private static readonly V1 = new SqlMigration(1, [
        'CREATE TABLE tenant_idp_sso_sessions (id_hash text PRIMARY KEY, realm_id text NOT NULL, account_id text NOT NULL, sign_in jsonb NOT NULL, expires_at timestamptz NOT NULL)',
        'CREATE INDEX tenant_idp_sso_sessions_account ON tenant_idp_sso_sessions (realm_id, account_id)',
        'CREATE INDEX tenant_idp_sso_sessions_expires ON tenant_idp_sso_sessions (expires_at)',
    ]);

    public readonly Name = 'tenant_idp.sso_sessions';

    public Migrations(): readonly SqlMigration[]
    {
        return [IdpSsoSessionMigrations.V1];
    }
}

export class IdpRefreshTokenMigrations extends SqlMigrationModule
{
    private static readonly V1 = new SqlMigration(1, [
        'CREATE TABLE tenant_idp_refresh_tokens (token_hash text PRIMARY KEY, family_id text NOT NULL, realm_id text NOT NULL, client_id text NOT NULL, account_id text NOT NULL, sso_id_hash text, sign_in jsonb NOT NULL, issued_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, family_expires_at timestamptz NOT NULL, used_at timestamptz, revoked_at timestamptz)',
        'CREATE INDEX tenant_idp_refresh_tokens_family ON tenant_idp_refresh_tokens (family_id)',
        'CREATE INDEX tenant_idp_refresh_tokens_account ON tenant_idp_refresh_tokens (realm_id, account_id)',
        'CREATE INDEX tenant_idp_refresh_tokens_sso ON tenant_idp_refresh_tokens (sso_id_hash)',
        'CREATE INDEX tenant_idp_refresh_tokens_expires ON tenant_idp_refresh_tokens (family_expires_at)',
    ]);

    public readonly Name = 'tenant_idp.refresh_tokens';

    public Migrations(): readonly SqlMigration[]
    {
        return [IdpRefreshTokenMigrations.V1];
    }
}
