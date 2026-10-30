# SP-HIVE IdP realm credentials + claims (SH-D)

**Status:** design — FORK RESOLVED 2026-10-30: admin-token = **multiple valid
tokens**; password rotation = **both** (self-service-with-current + admin reset).
**Program:** SP-HIVE 100% burn-down, batch SH-D. Three SP-HIVE-6b realm
follow-ups in the in-repo tenant IdP realm (`src/idp`).

## Scope

- **IN:** (1) emit `email`/`name` id_token claims from the realm; (3) owner
  password rotation — BOTH self-service (verify current) AND admin-forced reset;
  (4) admin-token: accept MULTIPLE valid tokens (enables zero-downtime rotation).
- **DEFERRED:** item 2 "upstream `LocalAccount.DisplayName` (vs IdP profile
  side-store)" — a `todl-identity-local` sibling refactor (move displayName onto
  the account, drop `ProfileSideStore`). Its own follow-up; not here.

## Context (verified)

- The realm is in `pragmatic-server/src/idp` (run from the server image via the
  IdP entrypoint, `idp-main.ts`). It reuses `@pragmatic-tech-ai/todl-identity-local`
  stores + a `ProfileSideStore` (principalId→displayName). `IdpRealm.LookupProfile(principalId)`
  already returns `{ email, name }`.
- `TokenEndpoint` (token-endpoint.ts) signs the id_token (`signingKey.Sign({...})`)
  but omits email/name.
- `IdpAdminEndpoint` (idp-admin-endpoint.ts) verifies a single `adminToken`
  via `timingSafeEqual(Digest(presented), Digest(adminToken))`; constructed in
  `idp-main.ts` from `LoadAdminToken(data, PRAGMATIC_IDP_ADMIN_TOKEN_REF)`.
  `DockerIdpDriver` generates the token (randomBytes) into the secret-ref file.
- Gated by `npm test` (`tsx --test src/**/*.test.ts`).

## Items + acceptance + security requirements

1. **id_token email/name claims** (token-endpoint.ts + wiring in idp-main/
   idp-host). Thread the realm profile lookup (by `sub`/principalId) into the
   token path so the signed id_token carries `email` and `name`. Read from the
   realm (`LookupProfile`); do not invent values. If a profile has no name, omit
   `name` (or empty) rather than fabricate. No access-token/secret content
   changes. Test: a minted id_token for an account with email+name carries both
   claims; an account without a name still mints a valid token.

2. **Owner password rotation — BOTH paths** (idp-realm.ts + idp-admin-endpoint.ts
   + routing):
   - **Self-service:** verify the account's CURRENT password via the existing
     `LocalPasswordAuthenticator`, then (only on success) hash the new password
     (Argon2, reuse `this.hasher`) and store it via the Secrets store. A wrong
     current password must fail WITHOUT changing the stored secret. Never log or
     return either password.
   - **Admin-forced reset:** gated behind the admin endpoint (admin token); sets
     a new password WITHOUT the current one (recovery). Same hashing/storage.
   - Reuse `IdpRealm`'s secret-ref model (`SecretRefPrefix = 'idp-password/'`).
     Tests: self-service with correct current rotates; wrong current rejects and
     leaves the secret unchanged; admin reset sets a new password; after either,
     the new password authenticates and the old does not.

3. **Admin-token: multiple valid tokens** (idp-admin-endpoint.ts + idp-main.ts):
   - `IdpAdminEndpoint` accepts a SET of valid admin tokens; `VerifyToken`
     returns true if the presented token timing-safe-matches ANY member.
     **Constant-work:** compare against every member (or a digest-set membership
     that does not early-return on first match) so timing never reveals which
     token matched or how many exist. Reject when the set is empty.
   - `idp-main.LoadAdminToken` loads a SET from the ref (e.g. newline-separated,
     trimming blanks); a single-token ref still works (set of one) — backward
     compatible.
   - **Rotation model:** operator provisions the new set (old + new both present
     during overlap, then old removed) — the realm accepting a set is what makes
     that zero-downtime. A runtime add/revoke admin route is OUT of scope unless
     trivial; if added, it must persist and never echo a token.
   - Tests: any member authenticates; a non-member 401s; an empty set 401s all;
     the single-token ref remains valid.

## Constraints (Global)

- **EOL (critical, mixed base):** `idp-admin-endpoint.ts` and `idp-main.ts` are
  **CRLF at base** — PRESERVE CRLF (byte-scan base before editing; do NOT flip to
  LF). `token-endpoint.ts`, `idp-realm.ts`, `idp-host.ts` are LF. All `src/idp`
  files are 0 non-ASCII — keep ASCII. Byte-scan each touched file on the way out
  and confirm it matches its base EOL.
- **Never fabricate** a claim, a password, or a token. Reads come from the realm
  stores; new secrets are Argon2-hashed; tokens are provisioned, not minted here.
- Secrets/passwords/tokens NEVER logged, echoed, or returned in a result
  (the admin endpoint already guarantees this — preserve it).
- OOP + Allman braces; no inline string literals (hoist to
  `private static readonly`); enums over string unions; PascalCase public
  members; no module-level free functions/state.
- Gate: `npm test` (`tsx --test src/**/*.test.ts`) + `npm run typecheck:tools`.
- Merge locally (ff-only); **NEVER push** (unless separately instructed).

## Review focus

- **No credential leak:** no password/token/secret in any log, error, or
  response; timing-safe, constant-work admin-token verification across the set
  (no early-return timing oracle; empty-set rejects).
- **Self-service password safety:** a wrong current password never mutates the
  stored secret; the new secret is Argon2-hashed; old password stops working.
- **Claims fidelity:** email/name come from the realm profile, never invented;
  a missing name does not break token minting.
- **Back-compat:** a single-token admin ref still authenticates; existing token
  minting (iss/aud/sub/nonce/iat/exp) is unchanged apart from the added claims.
- **EOL:** the two CRLF-at-base files stay CRLF; no other file flipped.
