# DdLv8 Remove the dev CA private key (ca.key) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dev CA private key (`ca.key`) is never persisted by a mint and never shipped into an IdP pod — `DevCa` mints it in a temp staging dir, uses it to sign the server cert, and destroys it; pods and the control-plane retain only `{server.crt, server.key, ca.crt}`.

**Architecture:** Two interdependent edits that must land together. (1) `DevCa.EnsureAt` relaxes its idempotency guard to the three runtime files `{server.crt, server.key, ca.crt}` and stops `renameSync`-ing `ca.key` out of the staging dir (so it dies with staging). (2) `InClusterIdpSeedSource.TlsFiles` drops `'ca.key'` so the Secret projection no longer reads/ships it — required for correctness too, since once (1) lands the projection loop would otherwise `ENOENT` on `ca.key`. The pod needs no change: with the relaxed guard its `EnsureAt` over the read-only mount finds the three runtime files and does not re-mint.

**Tech Stack:** TypeScript (NodeNext ESM), `tsx --test`, openssl CLI (DevCa), docker-desktop k8s for the gated smoke. Single repo: pragmatic-server.

**Spec:** `docs/superpowers/specs/2026-10-26-sp-hive-ddlv8-ca-key-removal-design.md`

## Global Constraints

- OOP: methods/statics on classes; no module-level free functions or mutable state. Allman braces. No inline string literals (hoist to `private static readonly` PascalCase). PascalCase interfaces + public methods.
- SECRET-SAFETY (verbatim, load-bearing): the CA signing key (`ca.key`) must appear in NO persisted file (after a mint), NO k8s Secret, manifest, log, DTO, error, or thrown message. It may exist ONLY transiently in the mint staging dir (chmod 600) and is destroyed with that dir. `server.key` stays in the TLS Secret — that is the server's own TLS key, legitimately required to serve HTTPS, NOT the CA key.
- Forward-only scope: do NOT add any retroactive scrub of `ca.key` from existing Docker volumes or already-applied in-cluster Secrets (explicit non-goal).
- Tests live in `tests/` subfolders. NEVER `npm install` at repo root. LF-only. Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- No worktree; branch `feat/sp-hive-ddlv8-ca-key-removal` off master.

## Review Focus

1. **Guard correctness** — a dir with the three runtime files but no `ca.key` must NOT re-mint; a dir missing a runtime file MUST still re-mint. (Task 1 tests: both.)
2. **`ca.key` never persisted** — after `EnsureAt`, `ca.key` is absent from `dir` (control-plane and local/docker path). (Task 1 dev-ca + idp-service tests.)
3. **Secret non-leakage of the CA key** — the projected TLS Secret's data keys are exactly `{server.crt, server.key, ca.crt}`; `ca.key` is in no Secret/manifest/log/DTO/error. (Task 1 in-cluster-idp-seed test.)
4. **Pod still boots** — the pod's `EnsureAt` over the read-only mount passes without `ca.key` and does not write. (Task 1 gated smoke, operator-run.)
5. **Server TLS unchanged** — `server.{crt,key}`/`ca.crt`, the SAN and the trust chain are byte-equivalent; `IdpTlsMaterial.Load` and the serving path untouched. (dev-ca SAN/chain test stays green.)

---

## Task 1: DevCa stops persisting ca.key; drop it from the IdP TLS Secret

**Files:**
- Modify: `src/idp/dev-ca.ts` — `EnsureAt` guard drops the trailing `&& existsSync(join(dir, DevCa.CaKeyFile))` clause (check only `result.certFile`, `result.keyFile`, `result.caFile`); DELETE the `renameSync(join(stage, DevCa.CaKeyFile), join(dir, DevCa.CaKeyFile))` line at the top of the move block (so `ca.key` stays in `stage` and is removed by the existing `rmSync(stage, …)` in `finally`); rewrite the guard comment (currently "The mint also drops ca.key into `dir`; include it in the idempotency guard …") to state `ca.key` is a mint-time-only artifact intentionally NOT persisted. `CaKeyFile` stays referenced by `Mint` (openssl `-CAkey`) — do not remove it.
- Modify: `admin/control-plane/in-cluster-idp-seed.ts` — `TlsFiles` becomes `['server.crt', 'server.key', 'ca.crt']`; remove the stale two-line comment + the `TODO` above it (`:123-125`).
- Modify (tests): `src/idp/tests/dev-ca.test.ts`, `admin/control-plane/tests/idp-service.test.ts`, `admin/control-plane/tests/in-cluster-idp-seed.test.ts`
- Modify (smoke): `admin/control-plane/in-cluster-idp-smoke.ts`

**Interfaces:**
- `DevCa.EnsureAt(dir, host, openssl?)` signature and return `DevCaFiles` are UNCHANGED (still `{certFile, keyFile, caFile}` — these are `server.crt`/`server.key`/`ca.crt`). Only the guard and the ca.key persistence change. `IdpTlsMaterial.Load` unchanged.

- [ ] **Step 1: Write/adjust the failing tests.**
  - `src/idp/tests/dev-ca.test.ts`:
    - In "mints … idempotently": ADD `assert.ok(!existsSync(join(dir, 'ca.key')))` after `EnsureAt` (ca.key not persisted).
    - REPLACE "regenerates the full set when ca.key is missing from an otherwise-complete dir" with "treats the three runtime files as complete without ca.key (no re-mint)": `EnsureAt`; capture `server.crt` bytes; `ca.key` is already absent (never written); `EnsureAt` again; assert the second `server.crt` is byte-identical (`.equals`) to the first (NO re-mint) and `ca.key` is still absent.
    - ADD a sibling "re-mints when a runtime file is missing": `EnsureAt`; `rmSync(server.crt)`; `EnsureAt`; assert a fresh `server.crt` was minted (bytes differ) and all three runtime files exist.
  - `admin/control-plane/tests/idp-service.test.ts`: change the local-path existence loop from `['ca.key','ca.crt','server.key','server.crt']` to `['ca.crt','server.key','server.crt']`, and ADD `assert.ok(!existsSync(join(dir,'tls','ca.key')))`. (Loop order is irrelevant.)
  - `admin/control-plane/tests/in-cluster-idp-seed.test.ts`: ADD an assertion that the projected TLS Secret's `data` keys are exactly `{server.crt, server.key, ca.crt}` and that `data['ca.key']` is undefined. (No exact-key assertion exists today — this is new.)
- [ ] **Step 2: Run tests — expect fail** (`npx tsx --test src/idp/tests/dev-ca.test.ts admin/control-plane/tests/idp-service.test.ts admin/control-plane/tests/in-cluster-idp-seed.test.ts`).
- [ ] **Step 3: Implement** the `dev-ca.ts` guard + remove-the-rename edits and the `in-cluster-idp-seed.ts` `TlsFiles`/comment edits.
- [ ] **Step 4: Run tests — expect pass.** Then the full IdP suite (`npx tsx --test "src/idp/tests/**/*.test.ts"`) + the full control-plane suite (`npx tsx --test "admin/control-plane/tests/**/*.test.ts"`) + `tsc` (`tsconfig.tools.json`, `tsconfig.tenant-admin.json --noEmit`, `tsconfig.build.json --noEmit`). Grep the repo to confirm no remaining reader/mounter/asserter of `ca.key` besides `Mint`'s `-CAkey` use.
- [ ] **Step 5: Extend the gated smoke** — `in-cluster-idp-smoke.ts`: assert the applied per-tenant TLS Secret manifest has data keys `{server.crt, server.key, ca.crt}` and NO `ca.key`; and that a fresh in-cluster IdP pod comes up healthy (discovery/health/SSO) from that Secret (the pod's `EnsureAt` does not re-mint against the read-only mount). Mark operator-run; do NOT execute it.
- [ ] **Step 6: Commit** (branch `feat/sp-hive-ddlv8-ca-key-removal` off master).

---

## Self-Review

- **Spec coverage:** guard relaxation + no-persist (dev-ca.ts), Secret projection drop (in-cluster-idp-seed.ts), all three test updates, gated smoke — all in Task 1. Forward-only scope is an explicit non-goal (no scrub task). `idp-main.ts` unchanged (noted).
- **Step scan:** each step is one action; test step carries the exact assertions (byte-identical server.crt, re-mint-on-removed-runtime-file, exact Secret key set, ca.key-absent).
- **Type consistency:** `DevCa.EnsureAt`/`DevCaFiles`/`IdpTlsMaterial.Load` signatures unchanged; `TlsFiles` is a `string[]` literal, one fewer element.
- **Review Focus:** RF1/RF2/RF5 (dev-ca tests), RF2 (idp-service test), RF3 (seed test), RF4 (gated smoke) all pinned.
- **Proportion:** one small task; two source edits + four test/smoke edits; the plan pins the exact clauses to change and the exact assertions, no code bodies. Single task is correct because the two source edits are interdependent (neither stays green without the other).
