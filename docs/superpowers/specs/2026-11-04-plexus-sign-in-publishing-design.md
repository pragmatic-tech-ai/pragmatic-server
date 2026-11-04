# Plexus sign-in and publishing to environments

Status: draft for review (2026-11-04). Spans three repos: pragmatic-server (control plane, tenant plane, IdP, environment
server), Plexus (apps/plexus + packages/plexus-core) and, only if unavoidable, pragmatic-protocol.

## Intent

A maker working in Plexus wants to send their work to an environment of their tenant: **contribute** a solution's
compiled packages to a graph in a Development environment, and **publish** an app to a Runtime environment. Today both
work only for Docker environments, and only after the user pastes a server URL (with a hand-typed `?environment=`) and a
hand-minted token into a dialog. Environments on a cluster hive are unreachable from the desktop altogether.

The user's direction: **Plexus has a login.** You sign in with your email; Plexus gets your access and the environments
available to you from your signed-in profile. The publish/contribute dialogs stay, but their job becomes choosing the
target environment (from your profile), not entering connection details.

Exploring or editing an environment's graphs from inside Plexus (SP-GRAPH-6 "thin client") is explicitly out of scope;
the user is not sure they want it at all.

## Goals

1. **Sign in from Plexus by email.** The user types their email; the platform works out which tenant it belongs to; the
   system browser opens that tenant's normal IdP sign-in page; on success Plexus is signed in as that user. Plexus never
   sees or handles the password. Sign out is available. Signed-in state survives a Plexus restart.
2. **Profile-driven targets.** From the signed-in profile Plexus knows the user's tenant, role/capabilities and the
   environments they may target. Contribute offers the Development environments the user may contribute to; Publish
   offers the Runtime environments the user may deploy to.
3. **Dialogs become environment pickers.** Contribute dialog: pick a Development environment, then pick the graph
   (from that environment's existing graphs). Publish dialog: pick a Runtime environment. Signed out -> the dialog
   offers Sign in. Nothing eligible -> a plain sentence saying so, not an empty list. The last choice is pre-selected
   next time.
4. **Environments are reachable from the desktop**, including environments on a cluster hive (the local docker-desktop
   hive is the proving ground), with nothing for the user to configure.
5. **No credentials in front of the user.** No URLs, `?environment=` strings or tokens are typed, pasted or shown.
   Short-lived environment credentials are obtained and renewed behind the scenes.
6. **Access follows the account.** Signing out, an operator/Owner password reset, a self-service password change
   (which ends other sessions), or the account losing its grants ends or narrows Plexus's access the same way it does
   for the tenant console.

## Non-goals

- Browsing or editing environment graphs from Plexus (SP-GRAPH-6).
- Signing in to several tenants at once, or switching accounts without signing out.
- Offline operation.
- Changing what contribute or publish do once connected (`graph/contribute` and `application/deploy` stay as they are).
- Plexus-side password management (change/reset stays in the consoles).

## Anti-goals (a failure even if it works)

- The user typing a password into Plexus itself, or Plexus ever holding one.
- Any token, URL or environment id the user has to copy, paste or read.
- A long-lived credential stored unencrypted on disk, or logged anywhere (desktop or server).
- A credential that keeps working after the account's password was reset or the account was disabled.
- Plexus offering an environment the user then cannot actually contribute/publish to (offered == allowed).

## Constraints

- House rules for all repos: OOP (no module-level functions/variables), Allman braces, PascalCase public members and
  interfaces, string literals hoisted to `private static readonly` constants (except `.mu` labels), enums over string
  sets, view models extend `Observable`, tests in `tests/` folders, new files ASCII + LF, CRLF files stay CRLF.
- Layering: plexus-core never imports from apps/plexus; host capabilities reach plexus-core through `ServiceKey` seams
  declared in plexus-core (mirror the existing `ITenantPublisher` / graph-contributor seams).
- Secrets: tokens live only in the Electron main process (never the renderer), are encrypted at rest (mirror the existing
  `TenantProfileStore` / graph profile store), and never cross IPC back to the renderer, nor appear in logs, errors, DTOs.
- Node (and so Plexus's main process and its WebSocket dialer) cannot resolve `*.localhost` names on Windows (verified:
  `pragmatic-default.localhost` -> ENOTFOUND). Anything Plexus dials locally must be `localhost`/`127.0.0.1`.
- Merge locally; nothing is pushed without the user's explicit instruction.

## How it works (decided)

### 1. Email -> tenant (home-realm discovery)

*My call (where Plexus finds it):* Plexus has one setting, **Platform address**, defaulting to the local control plane
(`http://localhost:7000`); a hosted platform later just changes that default. Nothing else is configured.

The control plane gains a public discovery endpoint: given an email, it answers which tenant (id + display name) the
email belongs to and what Plexus needs to start sign-in for it (the tenant's IdP issuer / authorize endpoint and the
tenant plane address Plexus should use afterwards).

- *My call:* an email belonging to several tenants gets a chooser (tenant display names) in Plexus.
- *My call:* an unknown email gets a plain "no account found for this email". This reveals whether an email has an
  account; it is accepted for usability, and the endpoint is throttled per client address to bound enumeration.
- Where the email -> tenant knowledge comes from is left to the builder, with one rule: it must cover every account
  that can sign in to the tenant console (not only the Owner email the control plane records), and must not require
  calling every tenant's IdP on every lookup.

### 2. Native sign-in (system browser, exchange brokered by the tenant plane)

Plexus opens the system browser on the tenant's existing IdP sign-in page (authorization code + PKCE S256, which the IdP
already requires) with a **loopback redirect** (`http://127.0.0.1:<ephemeral port>/...`, per RFC 8252) so the browser
hands the code back to Plexus. The browser can reach the IdP (the tenant console's sign-in already works there); Plexus's
main process cannot (HTTPS on a dev CA, `host.docker.internal` / `*.localhost` / in-cluster names).

*My call:* therefore **the tenant plane brokers the exchange.** Plexus sends the code and its PKCE verifier to the tenant
plane; the tenant plane redeems it at the IdP server-side (it already trusts the IdP and does exactly this for the
console), checks the identity, and issues Plexus a **desktop session**: an opaque bearer held by the tenant plane's
existing session store, the same kind of record as a console session. Consequences:

- Plexus never talks to the IdP's token endpoint, never needs the dev CA, and never holds IdP tokens.
- Goal 6 comes from the existing machinery: a password reset, a self-service change (which ends other sessions), an
  account disable or Sign out revoke desktop sessions exactly as they revoke console sessions.
- Staying signed in across restarts = the desktop session's lifetime (*my call:* longer than a console session, e.g.
  days, with sliding renewal on use; the builder picks the exact numbers).
- IdP work: the loopback redirect must be accepted for the client used here, matching any port on `127.0.0.1` for a
  registered loopback path (whether that is the tenant plane's existing client with an extra loopback redirect rule or a
  dedicated Plexus client per realm is left to the builder; registration/back-fill for existing tenants is in scope).

### 3. Desktop API on the tenant plane

The tenant plane accepts Plexus's desktop-session bearer on a narrow desktop surface:

- **Profile:** the same information as the console's `GET /tenant-api/profile` (tenant, role, capabilities, hive).
- **Targets:** the environments the user may contribute to (Development) and publish to (Runtime), each with only what
  the pickers need (name, type, status). Offered == allowed: the same capability/authorization check decides both the
  list and the later action.
  - *My call (authorization):* a user may contribute to every Development environment and publish to every Runtime
    environment of their tenant **iff their profile has the existing environments capability** (`envs` in
    `TenantAdminCapabilities`, which today both the Owner and Environment admins have). No new roles or per-environment
    grants in this work; finer "maker"/"deployer" roles are a later feature. "Losing access" in Goal 6 therefore means
    losing that capability or the account (sessions revoked).
- **Graphs of a Development environment** (names), for the contribute picker.
- **Relay** (below).

The tenant is derived from the bearer, never from the Host header or the request body (Plexus dials plain `localhost`).

*My call (which tenant plane):* Plexus always talks to **the tenant plane hosted by the control plane**, at a plain
`localhost`-reachable address that discovery returns; it serves every tenant (tenant from the bearer). Adding the desktop
API and relay to the in-hive tenant console is out of scope here (noted as a follow-up); the control plane's tenant plane
reaches hive environments through the tunnel described below.

### 4. Relay to the environment (credentials stay server-side)

Plexus does not connect to environment servers directly. It opens a WebSocket to the tenant plane's relay for a chosen
environment; the tenant plane authorizes the user for that environment and action, connects onward to the environment
server with a short-lived, narrowly scoped environment credential that **it** minted, and pipes the JSON-RPC traffic.
Plexus never holds environment tokens, so "renewal" is entirely server-side.

- Contribute: maker credential (existing `AdminIssueMakerToken`, scope `graph-contribute`, Development only).
- *My call (attribution):* environment credentials stay on the shared well-known principals (the existing `maker`
  principal, and an equivalent deploy principal). The tenant plane writes its own audit record for every relayed
  contribute/publish naming the signed-in user, environment, action and outcome, so "who did it" is answered there.
  Per-user principals inside environments are a later feature.
- Publish: *my call:* a new deploy-only credential (scope limited to `application/deploy`) for Runtime environments,
  replacing today's hand-made admin token. The builder must check whether the environment server enforces token scopes
  for `application/deploy`; if it does not, enforcing it is part of this work.
- *My call:* the relay only forwards the protocol methods the chosen action needs (contribute: `graph/contribute` and the
  graph listing it needs; publish: `application/deploy`), rejecting anything else.
- Reaching the environment server from the tenant plane:
  - Docker environment: its published `localhost` port (as today).
  - Cluster environment, tenant plane hosted by the control plane (local docker-desktop hive): the control plane manages
    a tunnel into the cluster per environment (kubectl port-forward or equivalent), opened on demand and closed when
    idle. *The same tunnel fixes a gap found in recon:* the control plane's admin calls to in-cluster environments
    (`AdminInfoFor` assumes `localhost:hostPort` and a local bundle dir) fail today, including maker-token minting; they
    must work through the tunnel, reading the environment's admin secret from the cluster rather than a local bundle.

### 5. Plexus UI

- An account area: **Sign in** (asks for email; tenant chooser if several; then the browser), **Signed in as
  <email> (<tenant>)**, **Sign out**.
- Contribute dialog: Development environment picker + graph picker (existing graphs of that environment). Publish
  dialog: Runtime environment picker. Both: Sign in when signed out; a plain sentence when nothing is eligible; last
  choice pre-selected. Today's Server URL / token fields are removed.
- Errors read as plain sentences (environment stopped, no permission, signed out, server unreachable), never a raw
  protocol error.

## Left to the builder

- Endpoint paths and DTO shapes; how discovery learns email -> tenant (within the rule above).
- The loopback-redirect client registration at the IdP and the desktop-session lifetime numbers, within Goal 6 and the
  anti-goals.
- Tunnel mechanics (port-forward lifecycle, idle timeout, reuse across callers) and how the control plane reads an
  in-cluster environment's admin secret.
- Relay framing details, timeouts and back-pressure.
- Where the account area lives in Plexus's shell, following its existing patterns.
- Migration: existing stored graph/tenant profiles in Plexus can be discarded on first run of the new version.

## Follow-ups (not in this work)

- Desktop API + relay on the in-hive tenant console (for hives whose console runs in the cluster).
- Finer roles (maker / deployer) and per-environment grants for tenant-console users.
- Per-user principals inside environments (attribution at the environment level).
- SP-GRAPH-6 thin client (browse/edit environment graphs from Plexus), if wanted at all.
