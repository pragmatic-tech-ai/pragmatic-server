# DdLv8 — Remove the dev CA private key (ca.key) from pods and disk (design)

**Status:** approved for planning (AFK autonomous run; merge locally, never push).
**Project item:** `PVTI_lADOE0Zc984Biu4ozhDdLv8` (Kind=Feature) — "ca.key removal + IdP seed durability".
**Spun off from:** P4 in-cluster-IdP-apply, which shipped the per-tenant IdP TLS Secret but mounted the CA
**private** signing key (`ca.key`) into every IdP pod to satisfy `DevCa.EnsureAt`'s idempotency guard
(the stale `TODO` at `admin/control-plane/in-cluster-idp-seed.ts:123-125`).

## Intent & why

`DevCa.EnsureAt` (`src/idp/dev-ca.ts`) mints a self-signed dev CA (`ca.key` + `ca.crt`) and a CA-signed
server cert (`server.key` + `server.crt`). The IdP serves HTTPS with `server.crt`/`server.key`; clients
trust `ca.crt`. **`ca.key` (the CA signing key) is used only at mint time to sign the server cert — nothing
reads it at runtime** (`IdpTlsMaterial.Load` reads only the server cert + key; there is no same-CA re-issue
path — any regeneration re-mints the whole CA).

Yet today `ca.key` is (a) persisted into the mint `dir`, and (b) projected into every in-cluster IdP pod's
TLS Secret. The reason is purely mechanical: the pod runs `DevCa.EnsureAt` against its mounted TLS dir
(`src/idp/idp-main.ts:85`), and the idempotency guard (`dev-ca.ts:77`) requires `ca.key` present or it
re-mints — which, against a read-only Secret mount, crashes the pod. So `ca.key` is shipped only to keep the
guard quiet. The cost is severe: the CA signing key — which can mint any cert the clients trust — sits at
rest in every env/IdP pod Secret. Compromise of one pod yields the CA key.

This stops `ca.key` from ever being written by a mint (chosen posture — see Decisions): the CA signing key
exists only transiently in a temp staging dir during the mint, then is destroyed. From the fix forward, pods
and the control-plane retain only `{server.crt, server.key, ca.crt}`.

**Scope is forward-only.** The change affects NEW mints and NEW seeds. It does not retroactively scrub a
`ca.key` that a prior build already wrote into a persistent Docker TLS dir / named volume, nor one already
present in an already-applied in-cluster TLS Secret — those are dev environments that pick up the fix the
next time their TLS is (re-)minted or (re-)seeded. Retroactive scrubbing of live Secrets/volumes is a
separate migration, not in scope here (and unnecessary for dev CAs, which re-provision freely).

## The mechanism

1. **Guard on the three runtime files only.** `DevCa.EnsureAt`'s idempotency check (`dev-ca.ts:77`) drops the
   `ca.key` existence clause and checks `{certFile (server.crt), keyFile (server.key), caFile (ca.crt)}`.
   Those are exactly what the IdP needs to serve HTTPS; `ca.key` was only a mint input. A dir missing any of
   the three still re-mints (unchanged safety); a dir with all three but no `ca.key` is correctly complete
   (the in-cluster read-only-mount case, and the post-fix normal case).
2. **Never persist `ca.key`.** `DevCa.Mint` still writes `ca.key` into the **staging** dir (openssl's
   `-CAkey` needs it to sign the server cert), but `EnsureAt` no longer `renameSync`s it into `dir`
   (`dev-ca.ts:87`). It is destroyed with the staging dir (`rmSync(stage, …)`). `ca.key` therefore never
   lands in any persistent dir on any host — control-plane or pod.
3. **Drop `ca.key` from the Secret projection.** `InClusterIdpSeedSource.TlsFiles`
   (`in-cluster-idp-seed.ts:126`) becomes `['server.crt', 'server.key', 'ca.crt']`; the stale comment + TODO
   go. The projected per-tenant TLS Secret carries only the three runtime files. (With `ca.key` no longer
   persisted by `EnsureAt`, the projection loop would fail trying to read it anyway — so this edit is both
   the security fix and required for correctness.)
4. **Pod needs no change.** `idp-main.ts:85` still calls `DevCa.EnsureAt(<TlsDir>, host)`; with the relaxed
   guard it finds the three runtime files on the read-only mount, passes, and does NOT re-mint. `server.key`
   stays in the Secret — that is the server's own TLS key, legitimately required to serve HTTPS, and is NOT
   the CA key.

## Decisions (user + mine)

- **Discard `ca.key` entirely (user's choice).** No mint persists the CA signing key on the control-plane
  or in any pod — minted in a temp dir, used to sign, destroyed. Most secure; removes the footgun uniformly
  for all `DevCa` callers (Docker/local + in-cluster) from the fix forward (see the forward-only scope note
  above). Future server-cert rotation re-mints the whole CA and clients re-fetch the new `ca.crt` — already
  the behavior on any regeneration today.
- **Guard = the three runtime files.** The IdP's serving set; `ca.key` was never part of what "complete"
  should mean for a running IdP. This is the single change that lets the pod stop shipping the CA key.
- **No trust-model change.** Clients still trust `ca.crt`; the server cert, its SAN, and the serving path are
  untouched. `IdpTlsMaterial.Load` is unchanged.
- **`ca.key` still minted in staging.** openssl must have the CA key to sign the CSR; it just isn't moved out
  of the staging dir. `chmod 600` on the staging `ca.key` is retained (defense-in-depth while it briefly
  exists).
- **Uniform change (not in-cluster-only).** Fixing only the in-cluster projection and leaving `DevCa`
  persisting `ca.key` on the control-plane was the rejected alternative (Approach B); the user chose the
  stronger, simpler posture where no component retains the CA key.

## Non-goals / anti-goals

- No change to how the IdP serves HTTPS, to the trust anchor, or to `server.key` in the Secret (the server's
  own TLS key is legitimately required there).
- No cert-rotation / same-CA re-issue feature (would be a deliberate future design; its absence is why
  retaining `ca.key` buys nothing today).
- No change to the admin-token Secret, the IdP signing key, or the master key.
- No change to the Docker IdP serving path beyond `DevCa` no longer leaving `ca.key` on disk.

## Component shape (for the plan)

- `src/idp/dev-ca.ts` — `EnsureAt` guard drops the `ca.key` clause (check only certFile/keyFile/caFile); the
  `renameSync` of `ca.key` into `dir` is removed (ca.key stays in and dies with the staging dir). Update the
  guard comment to state `ca.key` is a mint-time-only artifact that is intentionally not persisted.
- `admin/control-plane/in-cluster-idp-seed.ts` — `TlsFiles` drops `'ca.key'`; remove the stale comment/TODO.
- `src/idp/idp-main.ts` — no change (behavior follows the relaxed guard). Noted for the reviewer.

## Verification

- **Unit (`tsx --test`, no cluster):**
  - `src/idp/tests/dev-ca.test.ts`:
    - "mints … idempotently" keeps passing (three runtime files stable across two `EnsureAt` calls);
      ADD an assertion that `ca.key` is NOT present in `dir` after `EnsureAt`.
    - REWRITE "regenerates the full set when ca.key is missing" → "treats the three runtime files as
      complete without ca.key (no re-mint)": `EnsureAt`; `ca.key` is absent (never written); a second
      `EnsureAt` returns byte-identical `server.crt` (no re-mint). ADD a sibling: removing a **runtime**
      file (e.g. `server.crt`) DOES re-mint (the guard still protects a partially-cleaned dir).
    - SAN/chain, openssl-missing, invalid-host tests unchanged.
  - `admin/control-plane/tests/idp-service.test.ts` — the local-path existence loop drops `'ca.key'` (now
    `['ca.crt','server.key','server.crt']` + the admin token); ADD that `ca.key` is absent from the tls dir.
  - `admin/control-plane/tests/in-cluster-idp-seed.test.ts` — ADD that the projected TLS Secret's `data` has
    keys exactly `{server.crt, server.key, ca.crt}` and NO `ca.key` (secret non-leakage of the CA key).
- **Gated live smoke (`in-cluster-idp-smoke`, operator-run, docker-desktop):** a fresh in-cluster IdP pod
  comes up healthy from a TLS Secret that contains NO `ca.key` (the pod's `EnsureAt` does not re-mint against
  the read-only mount); discovery/health/SSO still pass; assert the applied TLS Secret manifest has no
  `ca.key` data key.
- IdP unit suite + control-plane unit suite green; `tsc` tools+tenant-admin+build clean.

## Review focus (likely-to-bite, pin each in a task test)

1. **Guard correctness** — a dir with the three runtime files but no `ca.key` must NOT re-mint (the whole
   point); a dir missing a runtime file MUST still re-mint. Both pinned.
2. **`ca.key` never persisted** — after `EnsureAt`, `ca.key` is absent from `dir` (control-plane AND the
   local/docker path). Pinned in dev-ca + idp-service tests.
3. **Secret non-leakage of the CA key** — the projected TLS Secret carries only the three runtime files;
   `ca.key` appears in no Secret, manifest, log, DTO, or error. Pinned in the seed test.
4. **Pod still boots** — with the relaxed guard the pod's `EnsureAt` over the read-only mount passes without
   `ca.key` and does not attempt a write. Covered by the gated smoke (operator-run).
5. **Server TLS unchanged** — `server.key`/`server.crt`/`ca.crt` and the SAN/trust chain are byte-equivalent
   to before; `IdpTlsMaterial.Load` and the serving path are untouched. (dev-ca SAN/chain test stays green.)
