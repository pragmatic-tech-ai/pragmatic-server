#!/usr/bin/env bash
# pragmatic-postgres-reconcile.sh plan
#
# Prints the SQL that makes this server match its configuration: one database and one role per application in the
# applications file, each role's password from that application's secret file, and the superuser's password from
# POSTGRES_PASSWORD_FILE. Every statement is idempotent: an existing database or role is kept (never dropped, never
# re-created), its password is set again from the file, and an application removed from the file is left untouched.
# The configuration is validated in full before anything is printed; any fault refuses with exit 1 and nothing to run.
#
# The printed SQL carries only names and file paths, never a password: the server reads each password file itself
# (pg_read_file, as the superuser, inside the same container), so no password reaches argv, the environment or a log.
#
# Inputs (environment):
#   PRAGMATIC_POSTGRES_APPLICATIONS  the applications file: one `<application> <database> <role>` per line, `#` comments
#   PRAGMATIC_POSTGRES_SECRETS_DIR   the folder holding one password file per application, named after the application
#   POSTGRES_PASSWORD_FILE           the superuser's password file (optional: without it the superuser is left alone)
#   POSTGRES_USER                    the superuser's name (default postgres)
set -euo pipefail

readonly ME='pragmatic-postgres'
readonly APPLICATION_PATTERN='^[a-z][a-z0-9-]{0,62}$'
readonly IDENTIFIER_PATTERN='^[a-z_][a-z0-9_]{0,62}$'
# Paths go into the SQL as plain literals, so only characters that need no quoting are accepted.
readonly PATH_PATTERN='^/[A-Za-z0-9/._-]*$'

refuse()
{
    printf '%s: %s\n' "$ME" "$*" >&2
    exit 1
}

require_path()
{
    local name="$1" value="$2"
    [[ "$value" =~ $PATH_PATTERN ]] || refuse "$name must be an absolute path of letters, digits and / . _ - (got: $value)"
}

# A password file must be readable and hold something besides line breaks (the server strips trailing CR/LF).
require_password_file()
{
    local file="$1" owner="$2"
    [ -f "$file" ] && [ -r "$file" ] || refuse "$owner: no password file $file"
    [ -n "$(tr -d '\r\n' < "$file")" ] || refuse "$owner: the password file $file is empty"
}

reserved_database()
{
    case "$1" in
        postgres|template0|template1|pg_*) return 0 ;;
    esac
    return 1
}

reserved_role()
{
    case "$1" in
        postgres|public|pg_*) return 0 ;;
    esac
    [ "$1" = "$SUPERUSER" ]
}

# Reads and validates the applications file into APPLICATIONS / DATABASES / ROLES (same index per line).
read_applications()
{
    local file="$PRAGMATIC_POSTGRES_APPLICATIONS" number=0 line extra application database role
    [ -f "$file" ] && [ -r "$file" ] || refuse "cannot read the applications file $file"
    declare -gA SEEN_APPLICATION=() SEEN_DATABASE=() SEEN_ROLE=()
    APPLICATIONS=() DATABASES=() ROLES=()
    while IFS= read -r line || [ -n "$line" ]
    do
        number=$((number + 1))
        line="${line%%#*}"
        line="${line//$'\r'/}"
        read -r application database role extra <<< "$line" || true
        [ -z "${application:-}" ] && continue
        local at="$file:$number"
        [ -n "${role:-}" ] && [ -z "${extra:-}" ] || refuse "$at: expected <application> <database> <role>"
        [[ "$application" =~ $APPLICATION_PATTERN ]] || refuse "$at: application name $application must match $APPLICATION_PATTERN"
        [[ "$database" =~ $IDENTIFIER_PATTERN ]] || refuse "$at: database name $database must match $IDENTIFIER_PATTERN"
        [[ "$role" =~ $IDENTIFIER_PATTERN ]] || refuse "$at: role name $role must match $IDENTIFIER_PATTERN"
        ! reserved_database "$database" || refuse "$at: database name $database is reserved"
        ! reserved_role "$role" || refuse "$at: role name $role is reserved"
        [ -z "${SEEN_APPLICATION[$application]:-}" ] || refuse "$at: application $application is listed twice"
        [ -z "${SEEN_DATABASE[$database]:-}" ] || refuse "$at: database $database is listed twice"
        [ -z "${SEEN_ROLE[$role]:-}" ] || refuse "$at: role $role is listed twice"
        SEEN_APPLICATION[$application]=1
        SEEN_DATABASE[$database]=1
        SEEN_ROLE[$role]=1
        APPLICATIONS+=("$application")
        DATABASES+=("$database")
        ROLES+=("$role")
    done < "$file"
}

print_superuser()
{
    cat <<SQL
-- the superuser
DO \$pragmatic\$
DECLARE
    secret text := rtrim(pg_read_file('$POSTGRES_PASSWORD_FILE'), E'\\r\\n');
BEGIN
    IF secret = '' THEN
        RAISE EXCEPTION '$ME: the superuser password file is empty';
    END IF;
    EXECUTE format('ALTER ROLE %I PASSWORD %L', '$SUPERUSER', secret);
END
\$pragmatic\$;
SQL
}

print_application()
{
    local application="$1" database="$2" role="$3"
    local file="$PRAGMATIC_POSTGRES_SECRETS_DIR/$application"
    cat <<SQL
-- application $application
DO \$pragmatic\$
DECLARE
    secret text := rtrim(pg_read_file('$file'), E'\\r\\n');
BEGIN
    IF secret = '' THEN
        RAISE EXCEPTION '$ME: application $application: the password file is empty';
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$role') THEN
        EXECUTE format('CREATE ROLE %I', '$role');
    END IF;
    EXECUTE format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', '$role', secret);
END
\$pragmatic\$;
SELECT format('CREATE DATABASE %I OWNER %I', '$database', '$role')
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$database') \\gexec
DO \$pragmatic\$
DECLARE
    current_owner name := (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '$database');
BEGIN
    IF current_owner <> '$role' THEN
        RAISE EXCEPTION '$ME: application $application: database $database is owned by %, not $role', current_owner;
    END IF;
END
\$pragmatic\$;
REVOKE ALL ON DATABASE "$database" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE "$database" TO "$role";
SQL
}

plan()
{
    SUPERUSER="${POSTGRES_USER:-postgres}"
    [[ "$SUPERUSER" =~ $IDENTIFIER_PATTERN ]] || refuse "POSTGRES_USER $SUPERUSER must match $IDENTIFIER_PATTERN"
    require_path PRAGMATIC_POSTGRES_APPLICATIONS "${PRAGMATIC_POSTGRES_APPLICATIONS:-}"
    require_path PRAGMATIC_POSTGRES_SECRETS_DIR "${PRAGMATIC_POSTGRES_SECRETS_DIR:-}"
    if [ -n "${POSTGRES_PASSWORD_FILE:-}" ]
    then
        require_path POSTGRES_PASSWORD_FILE "$POSTGRES_PASSWORD_FILE"
        require_password_file "$POSTGRES_PASSWORD_FILE" 'the superuser'
    fi
    read_applications
    local i
    for i in "${!APPLICATIONS[@]}"
    do
        require_password_file "$PRAGMATIC_POSTGRES_SECRETS_DIR/${APPLICATIONS[$i]}" "application ${APPLICATIONS[$i]}"
    done
    # A role with no CONNECT on a database cannot open it; PUBLIC loses it on the maintenance and template databases.
    printf '%s\n' '-- pragmatic-postgres reconcile' \
        'REVOKE CONNECT ON DATABASE "postgres" FROM PUBLIC;' \
        'REVOKE CONNECT ON DATABASE "template1" FROM PUBLIC;'
    if [ -n "${POSTGRES_PASSWORD_FILE:-}" ]
    then
        print_superuser
    fi
    for i in "${!APPLICATIONS[@]}"
    do
        print_application "${APPLICATIONS[$i]}" "${DATABASES[$i]}" "${ROLES[$i]}"
    done
}

case "${1:-}" in
    plan) plan ;;
    *)
        printf 'usage: pragmatic-postgres-reconcile.sh plan\n' >&2
        exit 2
        ;;
esac
