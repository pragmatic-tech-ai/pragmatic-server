# SP-HIVE IdP Realm Credentials + Claims (SH-D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** In the in-repo tenant IdP realm (`src/idp`): emit email/name id_token claims; add owner password rotation (self-service + admin reset); let the admin endpoint accept multiple valid admin tokens.

**Spec:** `docs/superpowers/specs/2026-10-30-sp-hive-idp-realm-credentials-design.md` (fork decisions + security requirements — read it).

## Global Constraints

- **EOL (mixed base — critical):** `src/idp/idp-admin-endpoint.ts` and `src/idp/idp-main.ts` are **CRLF at base — keep CRLF**; `src/idp/token-endpoint.ts`, `idp-realm.ts`, `idp-host.ts` are LF. Byte-scan BASE before editing (`git show master:PATH | python -c "import sys;b=sys.stdin.buffer.read();print(b.count(13),b.count(10))"`) and match it on the way out. All `src/idp` files are 0 non-ASCII — keep ASCII.
- Never fabricate a claim/password/token. Secrets/passwords/tokens NEVER logged, echoed, or returned.
- OOP + Allman braces; no inline string literals (hoist to `private static readonly`); PascalCase public members.
- Gate: `npm test` (`tsx --test src/**/*.test.ts`) + `npm run typecheck:tools`.
- Merge locally (ff-only); **NEVER push.** Stage source/test by explicit path; never `git add -A`; never docs.

## Review Focus

- No password/token/secret in any log/error/response; admin-token verify is timing-safe AND constant-work across the set (no first-match timing oracle; empty set rejects).
- Self-service password: wrong current password never mutates the stored secret; new secret Argon2-hashed; old password stops working.
- Claims come from the realm profile, never invented; a missing name does not break minting.
- Back-compat: single-token admin ref still authenticates; existing id_token fields unchanged apart from added claims.

---

### Task 1: Admin endpoint accepts multiple valid admin tokens (item 4)

**Files:** `src/idp/idp-admin-endpoint.ts` (CRLF), `src/idp/idp-main.ts` (CRLF), tests under `src/idp/tests/`.

- [ ] Failing tests: any member of the token set authenticates; a non-member 401s; an empty set 401s everything; a single-token ref still authenticates (back-compat).
- [ ] Implement: `IdpAdminEndpoint` takes a readonly set/array of admin tokens; `VerifyToken` compares the presented token timing-safe against EVERY member (constant work, no early return revealing match position/count); empty set always fails. `idp-main.LoadAdminToken` parses the ref into a set (newline-separated, trim blanks; one line = set of one). Keep both files CRLF.
- [ ] Verify `npm test` + `npm run typecheck:tools`; byte-scan (both files stay CRLF). Commit (explicit paths).

### Task 2: id_token email/name claims (item 1)

**Files:** `src/idp/token-endpoint.ts` (LF), wiring in `src/idp/idp-main.ts` (CRLF) / `src/idp/idp-host.ts` (LF) to give the token path the realm profile lookup, tests.

- [ ] Failing tests: a minted id_token for an account with email+name carries `email` and `name`; an account with no name still mints a valid token (name omitted/empty, no throw).
- [ ] Implement: thread `IdpRealm.LookupProfile(sub)` into `TokenEndpoint` so the signed id_token includes `email` and `name` read from the realm; omit `name` when absent; do not invent values; no change to access token or other claims.
- [ ] Verify + byte-scan (match base EOL per file) + commit (explicit paths).

### Task 3: Owner password rotation — self-service + admin reset (item 3)

**Files:** `src/idp/idp-realm.ts` (LF), `src/idp/idp-admin-endpoint.ts` (CRLF) + routing for the admin-reset path, `src/idp/idp-host.ts` (LF) for the self-service route, tests.

- [ ] Failing tests: self-service with correct current password rotates (new authenticates, old fails); wrong current password rejects AND leaves the stored secret unchanged; admin-forced reset (admin token) sets a new password without the current one; after each, old password no longer authenticates.
- [ ] Implement: add a realm method to rotate a password — self-service variant verifies the current password via `LocalPasswordAuthenticator` then Argon2-hashes + stores the new secret (reuse the `idp-password/` ref model); admin-reset variant skips the current-password check and is reachable only behind the admin endpoint (admin token). Never log/echo either password. Route the self-service path on the realm host and the admin-reset on the admin endpoint.
- [ ] Verify `npm test` + `npm run typecheck:tools`; byte-scan (match base EOL per file). Commit (explicit paths).

## Final verification (whole branch)

- `npm test` (`tsx --test src/**/*.test.ts`) — all pass.
- `npm run typecheck:tools` — exit 0.
- Byte-scan every touched file: matches base EOL (idp-admin-endpoint.ts + idp-main.ts CRLF; others LF); 0 non-ASCII.
