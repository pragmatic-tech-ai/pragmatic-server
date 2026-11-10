#!/bin/sh
# Points TODL's @pragmatic-tech-ai/graph at the sibling pragmatic-graph checkout.
#
# Usage: link-graph-engine.sh <workspace-root>
#
# TODL's lock resolves the engine from GitHub Packages (TODL's own CI has no sibling checkout), while the
# server depends on file:../pragmatic-graph. Left alone, the workspace would hold two engine copies:
# TODL's engine-bridge would build its scopes and snapshots against one and the server would run them on
# the other. Re-pointing TODL at the sibling leaves ONE engine, the same layout as local development.
# Re-run it after any `npm install` / `npm prune` in TODL, since those restore or drop the registry copy.
set -eu
root="$1"
scope="$root/TODL/node_modules/@pragmatic-tech-ai"
if [ ! -d "$root/pragmatic-graph" ]; then
    echo "link-graph-engine: $root/pragmatic-graph is missing" >&2
    exit 1
fi
mkdir -p "$scope"
rm -rf "$scope/graph"
ln -s ../../../pragmatic-graph "$scope/graph"
echo "link-graph-engine: TODL -> $(cd "$scope/graph" && pwd -P)"
