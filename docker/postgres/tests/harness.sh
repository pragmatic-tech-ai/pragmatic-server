#!/usr/bin/env bash
# A small bats-like test harness: a test file defines `test_<name>` functions and ends with `harness_run`, which runs
# each in its own subshell (so a failed assertion or `exit` ends only that case), prints TAP and exits non-zero when
# any case failed. Assertions print what differed to stderr and return 1.

HARNESS_FAILED=0
HARNESS_COUNT=0

fail()
{
    printf '  # %s\n' "$@" >&2
    return 1
}

assert_eq()
{
    local expected="$1" actual="$2" what="${3:-value}"
    if [ "$expected" != "$actual" ]
    then
        fail "$what: expected [$expected]" "$what: actual   [$actual]"
    fi
}

assert_contains()
{
    local haystack="$1" needle="$2" what="${3:-output}"
    case "$haystack" in
        *"$needle"*) return 0 ;;
    esac
    fail "$what does not contain [$needle]" "$what: [$haystack]"
}

assert_not_contains()
{
    local haystack="$1" needle="$2" what="${3:-output}"
    case "$haystack" in
        *"$needle"*) fail "$what contains [$needle]" ;;
    esac
    return 0
}

# Runs a command, capturing stdout+stderr in $output and the exit code in $status (never fails itself).
run()
{
    set +e
    output="$("$@" 2>&1)"
    status=$?
    set -e
}

harness_run()
{
    local name rc
    for name in $(declare -F | awk '{ print $3 }' | grep '^test_')
    do
        HARNESS_COUNT=$((HARNESS_COUNT + 1))
        # Not inside `if`: bash ignores errexit in a condition, so a failed assertion would not end the case.
        set +e
        (set -e; "$name")
        rc=$?
        set -e
        if [ "$rc" -eq 0 ]
        then
            printf 'ok %d - %s\n' "$HARNESS_COUNT" "${name#test_}"
        else
            printf 'not ok %d - %s\n' "$HARNESS_COUNT" "${name#test_}"
            HARNESS_FAILED=$((HARNESS_FAILED + 1))
        fi
    done
    printf '1..%d\n' "$HARNESS_COUNT"
    if [ "$HARNESS_FAILED" -ne 0 ]
    then
        printf '# %d of %d failed\n' "$HARNESS_FAILED" "$HARNESS_COUNT" >&2
        exit 1
    fi
}
