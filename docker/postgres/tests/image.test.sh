#!/usr/bin/env bash
# The pragmatic-postgres image end to end on a docker host: two applications, isolation between them, a restart with a
# third added (the first two keep their data), a changed password file, refusals that change nothing.
# Run: bash docker/postgres/tests/image.test.sh <image>   (e.g. ghcr.io/pragmatic-tech-ai/pragmatic-postgres:ci)
# Every container, volume and folder it creates is removed when it ends.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=harness.sh
source "$HERE/harness.sh"

IMAGE="${1:?usage: image.test.sh <image>}"
RUN_ID="pgtest-$$-$RANDOM"
WORK="$(mktemp -d)"
NAME="$RUN_ID"
VOLUME="$RUN_ID-data"
cleanup()
{
    docker rm -f "$NAME" > /dev/null 2>&1 || true
    docker volume rm "$VOLUME" > /dev/null 2>&1 || true
    rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$WORK/etc" "$WORK/secrets/applications"
chmod 0755 "$WORK" "$WORK/etc" "$WORK/secrets" "$WORK/secrets/applications"

secret()
{
    printf '%s\n' "$2" > "$WORK/secrets/$1"
    chmod 0644 "$WORK/secrets/$1"
}

applications()
{
    printf '%s\n' "$@" > "$WORK/etc/applications.conf"
    chmod 0644 "$WORK/etc/applications.conf"
}

start()
{
    docker rm -f "$NAME" > /dev/null 2>&1 || true
    docker run -d --name "$NAME" --read-only --tmpfs /var/run/postgresql --tmpfs /tmp \
        -v "$VOLUME:/var/lib/postgresql/data" \
        -v "$WORK/etc:/etc/pragmatic-postgres:ro" \
        -v "$WORK/secrets:/run/secrets/pragmatic-postgres:ro" \
        "$IMAGE" > /dev/null
}

wait_healthy()
{
    local i state
    for i in $(seq 1 90)
    do
        state="$(docker inspect -f '{{.State.Health.Status}} {{.State.Running}}' "$NAME" 2>/dev/null || true)"
        case "$state" in
            'healthy true') return 0 ;;
            *' false') docker logs "$NAME" >&2; fail "container stopped: $state" ;;
        esac
        sleep 1
    done
    docker logs "$NAME" >&2
    fail 'not healthy after 90 s'
}

# psql over TCP inside the container as <role>/<password> on <database>; the password reaches psql by its environment.
sql()
{
    local role="$1" password="$2" database="$3" query="$4"
    docker exec -e PGPASSWORD="$password" "$NAME" \
        psql -X -q -t -A -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$role" -d "$database" -c "$query"
}

# One server for every case, in order: each case builds on the state the previous one left.
secret superuser 'super-1'
secret applications/alpha 'alpha-1'
secret applications/beta 'beta-1'
applications '# two applications' 'alpha alpha_db alpha_role' 'beta beta_db beta_role'
start

test_1_two_applications_start_healthy_as_a_non_root_user()
{
    wait_healthy
    assert_eq 999 "$(docker exec "$NAME" id -u)" uid
    run docker logs "$NAME"
    assert_contains "$output" 'pragmatic-postgres: reconciled 2 application(s)'
    assert_not_contains "$output" 'alpha-1' logs
    assert_not_contains "$output" 'super-1' logs
    assert_not_contains "$(docker inspect -f '{{json .Config.Env}}' "$NAME")" 'super-1' environment
}

test_2_each_role_opens_its_own_database()
{
    sql alpha_role alpha-1 alpha_db 'CREATE TABLE notes (body text); INSERT INTO notes VALUES ($$alpha data$$);'
    sql beta_role beta-1 beta_db 'CREATE TABLE notes (body text); INSERT INTO notes VALUES ($$beta data$$);'
    assert_eq 'alpha data' "$(sql alpha_role alpha-1 alpha_db 'SELECT body FROM notes')" alpha
    assert_eq 'beta data' "$(sql beta_role beta-1 beta_db 'SELECT body FROM notes')" beta
}

test_3_no_role_opens_another_database()
{
    run sql alpha_role alpha-1 beta_db 'SELECT 1'
    assert_eq 2 "$status" 'alpha on beta_db'
    assert_contains "$output" 'permission denied for database "beta_db"'
    run sql beta_role beta-1 alpha_db 'SELECT 1'
    assert_eq 2 "$status" 'beta on alpha_db'
    assert_contains "$output" 'permission denied for database "alpha_db"'
    run sql alpha_role alpha-1 postgres 'SELECT 1'
    assert_eq 2 "$status" 'alpha on postgres'
    run sql alpha_role beta-1 alpha_db 'SELECT 1'
    assert_eq 2 "$status" 'alpha with the wrong password'
    assert_contains "$output" 'password authentication failed'
}

test_4_application_roles_are_plain_and_the_superuser_password_comes_from_its_file()
{
    assert_eq 'f|f|f' "$(sql postgres super-1 postgres "SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = 'alpha_role'")" alpha_role
}

test_5_a_restart_with_a_third_application_and_a_new_password_keeps_the_data()
{
    secret applications/gamma 'gamma-1'
    secret applications/alpha 'alpha-2'
    applications 'alpha alpha_db alpha_role' 'beta beta_db beta_role' 'gamma gamma_db gamma_role'
    docker restart "$NAME" > /dev/null
    wait_healthy
    assert_eq 'alpha data' "$(sql alpha_role alpha-2 alpha_db 'SELECT body FROM notes')" 'alpha after restart'
    assert_eq 'beta data' "$(sql beta_role beta-1 beta_db 'SELECT body FROM notes')" 'beta after restart'
    assert_eq 1 "$(sql gamma_role gamma-1 gamma_db 'SELECT 1')" gamma
    run sql alpha_role alpha-1 alpha_db 'SELECT 1'
    assert_eq 2 "$status" 'the old alpha password'
    run sql gamma_role gamma-1 alpha_db 'SELECT 1'
    assert_eq 2 "$status" 'gamma on alpha_db'
}

test_6_a_changed_superuser_password_file_takes_effect()
{
    secret superuser 'super-2'
    docker restart "$NAME" > /dev/null
    wait_healthy
    assert_eq 1 "$(sql postgres super-2 postgres 'SELECT 1')" 'new superuser password'
    run sql postgres super-1 postgres 'SELECT 1'
    assert_eq 2 "$status" 'old superuser password'
}

test_7_a_missing_password_file_refuses_the_start_and_changes_nothing()
{
    applications 'alpha alpha_db alpha_role' 'beta beta_db beta_role' 'gamma gamma_db gamma_role' 'delta delta_db delta_role'
    docker restart "$NAME" > /dev/null || true
    local i
    for i in $(seq 1 30)
    do
        [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = false ] && break
        sleep 1
    done
    assert_eq false "$(docker inspect -f '{{.State.Running}}' "$NAME")" running
    assert_eq 1 "$(docker inspect -f '{{.State.ExitCode}}' "$NAME")" 'exit code'
    run docker logs "$NAME"
    assert_contains "$output" 'pragmatic-postgres: application delta: no password file /run/secrets/pragmatic-postgres/applications/delta'
    applications 'alpha alpha_db alpha_role' 'beta beta_db beta_role' 'gamma gamma_db gamma_role'
    docker start "$NAME" > /dev/null
    wait_healthy
    assert_eq 'alpha data' "$(sql alpha_role alpha-2 alpha_db 'SELECT body FROM notes')" 'alpha after the refused start'
    assert_eq '' "$(sql postgres super-2 postgres "SELECT datname FROM pg_database WHERE datname = 'delta_db'")" 'no delta database'
}

test_8_an_application_removed_from_the_file_keeps_its_database()
{
    applications 'alpha alpha_db alpha_role' 'gamma gamma_db gamma_role'
    docker restart "$NAME" > /dev/null
    wait_healthy
    assert_eq 'beta data' "$(sql beta_role beta-1 beta_db 'SELECT body FROM notes')" 'beta after removal'
}

harness_run
