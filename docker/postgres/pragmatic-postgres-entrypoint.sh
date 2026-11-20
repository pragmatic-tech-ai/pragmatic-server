#!/usr/bin/env bash
# The pragmatic-postgres entrypoint: the official image's entrypoint (sourced for its functions), plus a reconcile on
# EVERY start, not only on first initialization. Before the server accepts connections it is started socket-only, the
# reconcile plan (pragmatic-postgres-reconcile.sh) is applied, and it is stopped again; then the real server runs in
# the foreground. An application added to the applications file therefore gets its database and role on the next
# start, existing data is never touched, and a changed password file takes effect.
# The plan is validated before the data directory is touched: a bad applications file or a missing password file
# refuses the start (exit 1) with the reason on stderr and nothing changed.
set -Eeo pipefail

# shellcheck source=/dev/null
source /usr/local/bin/docker-entrypoint.sh

pragmatic_reconcile()
{
    printf '%s\n' "$1" | POSTGRES_DB= docker_process_sql --dbname postgres --quiet > /dev/null
}

pragmatic_main()
{
    if [ "${1:0:1}" = '-' ]
    then
        set -- postgres "$@"
    fi
    if [ "$1" != 'postgres' ] || _pg_want_help "$@"
    then
        exec "$@"
    fi
    # file_env (in docker_setup_env) unsets POSTGRES_PASSWORD_FILE once read; the reconcile still needs the path.
    export PRAGMATIC_POSTGRES_SUPERUSER_FILE="${PRAGMATIC_POSTGRES_SUPERUSER_FILE:-${POSTGRES_PASSWORD_FILE:-}}"
    docker_setup_env
    docker_create_db_directories
    if [ "$(id -u)" = '0' ]
    then
        exec gosu postgres "$BASH_SOURCE" "$@"
    fi
    local plan
    plan="$(POSTGRES_PASSWORD_FILE="$PRAGMATIC_POSTGRES_SUPERUSER_FILE" /usr/local/bin/pragmatic-postgres-reconcile.sh plan)"
    if [ -z "$DATABASE_ALREADY_EXISTS" ]
    then
        docker_verify_minimum_env
        docker_error_old_databases
        ls /docker-entrypoint-initdb.d/ > /dev/null
        docker_init_database_dir
        pg_setup_hba_conf "$@"
        export PGPASSWORD="${PGPASSWORD:-$POSTGRES_PASSWORD}"
        docker_temp_server_start "$@"
        docker_setup_db
        docker_process_init_files /docker-entrypoint-initdb.d/*
    else
        export PGPASSWORD="${PGPASSWORD:-$POSTGRES_PASSWORD}"
        docker_temp_server_start "$@"
    fi
    pragmatic_reconcile "$plan"
    docker_temp_server_stop
    unset PGPASSWORD
    printf 'pragmatic-postgres: reconciled %s application(s)\n' "$(grep -c '^-- application ' <<< "$plan" || true)"
    unset "${!POSTGRES_@}"
    exec "$@"
}

pragmatic_main "$@"
