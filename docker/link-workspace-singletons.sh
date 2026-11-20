#!/bin/sh
# Points the siblings' copies of the workspace singletons (@pragmatic-tech-ai/pragmatic-graph and
# @pragmatic-tech-ai/todl-runtime) at the sibling checkouts, so the workspace holds ONE copy of each.
#
# Usage: link-workspace-singletons.sh <workspace-root> [--unlink]
#
# The server depends on file:../pragmatic-graph and file:../todl-runtime, but the siblings' locks resolve both from
# GitHub Packages (their own CI has no sibling checkout): TODL's engine devDependency and todl-runtime, Mural's and
# todl-identity-engine's todl-runtime. Left alone, the workspace would hold two copies of each: TODL's engine-bridge
# would build scopes and snapshots against one engine and the server would run them on the other, and an object made
# from one todl-runtime fails `instanceof` against the other's class (a ConfirmAsk TODL's solution manager raises is
# not the ConfirmAsk the server's AutoConfirmPromptService tests for). Re-pointing every copy at the sibling leaves
# one of each, the same layout as local development.
#
# A copy is re-pointed where the sibling installed one or declares the package (TODL's engine is an optional peer,
# absent after a production prune, yet TODL's engine-bridge loads it). Re-run after any `npm install` / `npm prune` in a sibling, since
# those restore the registry copy. `--unlink` removes the links instead (a plain unlink, never walking into the
# sibling), for a prune that must not see them.
#
# On Windows (Git Bash) the links are directory junctions: Git Bash's `ln -s` copies the folder instead of linking
# it, which is exactly the second copy this script exists to remove. Junctions are made and removed through cmd,
# which never follows them.
set -eu
root="$1"
mode="${2:-link}"
singletons="pragmatic-graph todl-runtime"
consumers="TODL Mural pragmatic-protocol pragmatic-shared todl-identity-engine todl-connectors-host"
case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) windows=1 ;;
    *) windows=0 ;;
esac
for pkg in $singletons; do
    if [ ! -d "$root/$pkg" ]; then
        echo "link-workspace-singletons: $root/$pkg is missing" >&2
        exit 1
    fi
done
for consumer in $consumers; do
    [ -d "$root/$consumer" ] || continue
    scope="$root/$consumer/node_modules/@pragmatic-tech-ai"
    for pkg in $singletons; do
        target="$scope/$pkg"
        if [ "$mode" = "--unlink" ]; then
            if [ -L "$target" ]; then
                if [ "$windows" = 1 ]; then
                    MSYS2_ARG_CONV_EXCL="*" cmd /c rmdir "$(cygpath -aw "$target")"
                else
                    rm "$target"
                fi
                echo "link-workspace-singletons: unlinked $consumer -> $pkg"
            fi
            continue
        fi
        [ -L "$target" ] && continue
        if [ ! -e "$target" ] && ! grep -q "\"@pragmatic-tech-ai/$pkg\"" "$root/$consumer/package.json"; then
            continue
        fi
        mkdir -p "$scope"
        rm -rf "$target"
        if [ "$windows" = 1 ]; then
            MSYS2_ARG_CONV_EXCL="*" cmd /c mklink /J "$(cygpath -aw "$target")" "$(cygpath -aw "$root/$pkg")" > /dev/null
        else
            ln -s "../../../$pkg" "$target"
        fi
        echo "link-workspace-singletons: $consumer -> $(cd "$target" && pwd -P)"
    done
done
