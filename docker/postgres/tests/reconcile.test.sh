#!/usr/bin/env bash
# The reconcile plan without a database: configuration parsing, validation and the SQL it prints.
# Run: bash docker/postgres/tests/reconcile.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RECONCILE="$HERE/../pragmatic-postgres-reconcile.sh"
# shellcheck source=harness.sh
source "$HERE/harness.sh"

# A fresh fixture: an applications file, a secrets folder and a superuser password file.
fixture()
{
    if [ -n "${WORK:-}" ]; then rm -rf "$WORK"; fi
    WORK="$(mktemp -d)"
    trap 'rm -rf "$WORK"' EXIT
    mkdir -p "$WORK/etc" "$WORK/secrets/applications"
    export PRAGMATIC_POSTGRES_APPLICATIONS="$WORK/etc/applications.conf"
    export PRAGMATIC_POSTGRES_SECRETS_DIR="$WORK/secrets/applications"
    export POSTGRES_PASSWORD_FILE="$WORK/secrets/superuser"
    export POSTGRES_USER=postgres
    printf 'super-secret-value\n' > "$POSTGRES_PASSWORD_FILE"
    : > "$PRAGMATIC_POSTGRES_APPLICATIONS"
}

application()
{
    printf '%s %s %s\n' "$1" "$2" "$3" >> "$PRAGMATIC_POSTGRES_APPLICATIONS"
    printf 'pw-of-%s\n' "$1" > "$PRAGMATIC_POSTGRES_SECRETS_DIR/$1"
}

plan()
{
    run bash "$RECONCILE" plan
}

test_two_applications_get_a_role_and_a_database_each()
{
    fixture
    application tenant-idp tenant_idp tenant_idp_app
    application platform-admin platform_admin platform_admin_app
    plan
    assert_eq 0 "$status" status
    assert_contains "$output" "CREATE ROLE %I', 'tenant_idp_app'"
    assert_contains "$output" "CREATE DATABASE %I OWNER %I', 'tenant_idp', 'tenant_idp_app'"
    assert_contains "$output" "CREATE ROLE %I', 'platform_admin_app'"
    assert_contains "$output" "CREATE DATABASE %I OWNER %I', 'platform_admin', 'platform_admin_app'"
}

test_each_database_is_closed_to_public_and_open_to_its_role()
{
    fixture
    application tenant-idp tenant_idp tenant_idp_app
    plan
    assert_contains "$output" 'REVOKE ALL ON DATABASE "tenant_idp" FROM PUBLIC;'
    assert_contains "$output" 'GRANT CONNECT, TEMPORARY ON DATABASE "tenant_idp" TO "tenant_idp_app";'
    assert_contains "$output" 'REVOKE CONNECT ON DATABASE "postgres" FROM PUBLIC;'
    assert_contains "$output" 'REVOKE CONNECT ON DATABASE "template1" FROM PUBLIC;'
}

test_roles_are_plain_logins_whatever_they_were_before()
{
    fixture
    application tenant-idp tenant_idp tenant_idp_app
    plan
    assert_contains "$output" 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
}

test_passwords_are_read_by_the_server_from_their_files_never_printed()
{
    fixture
    application tenant-idp tenant_idp tenant_idp_app
    plan
    assert_contains "$output" "pg_read_file('$PRAGMATIC_POSTGRES_SECRETS_DIR/tenant-idp')"
    assert_contains "$output" "pg_read_file('$POSTGRES_PASSWORD_FILE')"
    assert_not_contains "$output" 'pw-of-tenant-idp'
    assert_not_contains "$output" 'super-secret-value'
}

test_the_superuser_password_follows_its_file()
{
    fixture
    plan
    assert_eq 0 "$status" status
    assert_contains "$output" "ALTER ROLE %I PASSWORD %L', 'postgres'"
}

test_without_a_superuser_password_file_the_superuser_password_is_left_alone()
{
    fixture
    unset POSTGRES_PASSWORD_FILE
    plan
    assert_eq 0 "$status" status
    assert_not_contains "$output" "'postgres', secret"
}

test_comments_and_blank_lines_are_ignored_and_the_order_is_kept()
{
    fixture
    printf '# applications of this hive\n\n   \n' > "$PRAGMATIC_POSTGRES_APPLICATIONS"
    application beta beta_db beta_role
    printf 'alpha alpha_db alpha_role   # trailing comment\n' >> "$PRAGMATIC_POSTGRES_APPLICATIONS"
    printf 'pw\n' > "$PRAGMATIC_POSTGRES_SECRETS_DIR/alpha"
    plan
    assert_eq 0 "$status" status
    local first="${output%%alpha_role*}"
    assert_contains "$first" 'beta_role' 'text before alpha'
}

test_an_empty_applications_file_reconciles_only_the_superuser()
{
    fixture
    plan
    assert_eq 0 "$status" status
    assert_not_contains "$output" 'CREATE DATABASE'
}

test_a_missing_applications_file_refuses()
{
    fixture
    rm "$PRAGMATIC_POSTGRES_APPLICATIONS"
    plan
    assert_eq 1 "$status" status
    assert_contains "$output" "cannot read the applications file $PRAGMATIC_POSTGRES_APPLICATIONS"
}

test_a_line_without_three_fields_refuses_naming_the_line()
{
    fixture
    application alpha alpha_db alpha_role
    printf 'beta beta_db\n' >> "$PRAGMATIC_POSTGRES_APPLICATIONS"
    plan
    assert_eq 1 "$status" status
    assert_contains "$output" "$PRAGMATIC_POSTGRES_APPLICATIONS:2: expected <application> <database> <role>"
    assert_not_contains "$output" 'CREATE'
}

test_bad_names_refuse()
{
    fixture
    application 'Alpha' alpha_db alpha_role
    plan
    assert_eq 1 "$status" status
    assert_contains "$output" ':1: application name'
    fixture
    application alpha 'Alpha-DB' alpha_role
    plan
    assert_eq 1 "$status" status
    assert_contains "$output" ':1: database name'
    fixture
    application alpha alpha_db "alpha';drop"
    plan
    assert_eq 1 "$status" status
    assert_contains "$output" ':1: role name'
    fixture
    application alpha alpha_db "$(printf 'r%.0s' $(seq 1 64))"
    plan
    assert_eq 1 "$status" status
    assert_contains "$output" ':1: role name'
}

test_reserved_names_refuse()
{
    local database role
    for database in postgres template0 template1 pg_x
    do
        fixture
        application alpha "$database" alpha_role
        plan
        assert_eq 1 "$status" "status for database $database"
        assert_contains "$output" ":1: database name $database is reserved"
    done
    for role in postgres public pg_monitor
    do
        fixture
        application alpha alpha_db "$role"
        plan
        assert_eq 1 "$status" "status for role $role"
        assert_contains "$output" ":1: role name $role is reserved"
    done
}

test_a_custom_superuser_name_is_reserved_too()
{
    fixture
    export POSTGRES_USER=hive_admin
    application alpha alpha_db hive_admin
    plan
    assert_eq 1 "$status" status
    assert_contains "$output" ':1: role name hive_admin is reserved'
}

test_duplicates_refuse()
{
    fixture
    application alpha alpha_db alpha_role
    application alpha other_db other_role
    plan
    assert_eq 1 "$status" status
    assert_contains "$output" ':2: application alpha is listed twice'
    fixture
    application alpha shared_db alpha_role
    application beta shared_db beta_role
    plan
    assert_eq 1 "$status" status
    assert_contains "$output" ':2: database shared_db is listed twice'
    fixture
    application alpha alpha_db shared_role
    application beta beta_db shared_role
    plan
    assert_eq 1 "$status" status
    assert_contains "$output" ':2: role shared_role is listed twice'
}

test_a_missing_or_empty_password_file_refuses_naming_the_application()
{
    fixture
    application alpha alpha_db alpha_role
    rm "$PRAGMATIC_POSTGRES_SECRETS_DIR/alpha"
    plan
    assert_eq 1 "$status" status
    assert_contains "$output" "application alpha: no password file $PRAGMATIC_POSTGRES_SECRETS_DIR/alpha"
    fixture
    application alpha alpha_db alpha_role
    printf '\n' > "$PRAGMATIC_POSTGRES_SECRETS_DIR/alpha"
    plan
    assert_eq 1 "$status" status
    assert_contains "$output" "application alpha: the password file $PRAGMATIC_POSTGRES_SECRETS_DIR/alpha is empty"
}

test_an_unreadable_superuser_password_file_refuses()
{
    fixture
    rm "$POSTGRES_PASSWORD_FILE"
    plan
    assert_eq 1 "$status" status
    assert_contains "$output" "the superuser: no password file $POSTGRES_PASSWORD_FILE"
}

test_a_path_that_cannot_be_a_plain_sql_literal_refuses()
{
    fixture
    export PRAGMATIC_POSTGRES_SECRETS_DIR="$WORK/it's"
    plan
    assert_eq 1 "$status" status
    assert_contains "$output" 'PRAGMATIC_POSTGRES_SECRETS_DIR must be an absolute path'
    fixture
    export PRAGMATIC_POSTGRES_SECRETS_DIR="relative/dir"
    plan
    assert_eq 1 "$status" status
    assert_contains "$output" 'PRAGMATIC_POSTGRES_SECRETS_DIR must be an absolute path'
}

test_an_unknown_command_refuses()
{
    fixture
    run bash "$RECONCILE" apply-everything
    assert_eq 2 "$status" status
    assert_contains "$output" 'usage: pragmatic-postgres-reconcile.sh plan'
}

harness_run
