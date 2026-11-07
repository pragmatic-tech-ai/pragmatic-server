# UX Design Brief — Platform Admin & Tenant Admin

**For: a design-focused Claude session.** This document is your complete instruction set. Read it top to bottom before producing anything. It tells you what the two products are, who uses them, every screen and state you must design, the design system to build on, what to deliver, and how your work will be judged. Where this brief leaves a choice open, make a reasonable one and note it as yours.

**Source of truth for the product:** `docs/superpowers/specs/2026-10-25-platform-and-tenant-admin-app-separation-design.md` (the application-separation design). If anything here disagrees with that spec, the spec wins — flag the conflict in your rationale.

---

## 0. How to use this brief (your task, output, and defaults)

You are designing the **UX** — information architecture, flows, screen layouts, component usage, and the content/vocabulary — for two separate web admin applications that share one design language.

**Produce, in this order:**

1. **Information architecture & navigation map** for each tool (sitemap + primary nav + where every screen lives).
2. **Wireflows** (low-fidelity) for the top user journeys listed in §4.8 and §5.8 — boxes-and-arrows showing screen-to-screen movement, decisions, and dead-ends.
3. **High-fidelity screens** for every screen enumerated in §4 and §5, as an **interactive HTML/React prototype** that uses the Pragmatic Labs Design System tokens (§3). Static mockups are acceptable only where interactivity adds nothing (e.g. an empty state). Prefer one clickable prototype per tool over disconnected images.
4. **A states matrix** (§6.4) proving each key screen is designed for loading / empty / populated / error / permission-denied.
5. **A short written UX rationale** (2–4 pages): the IA decisions, the trust-boundary choices (§6.1), and anything you resolved that this brief left open.

**Fidelity & platform defaults (override if the requester says otherwise):**

- Desktop-first, 1440px design width; must reflow usably to 1024px. Not a mobile product; phone layout is out of scope beyond "does not break."
- Light **and** dark themes, both from the design-system tokens — not a hand-picked second palette.
- Interactive prototype is the primary deliverable; the written spec supports it.

**Do not** design the marketing site, the end-user application runtime, the IdP's own login chrome, or any onboarding outside the two admin tools. **Do not** invent backend capabilities — design only for the operations enumerated here.

---

## 1. Product context in one paragraph

Pragmatic runs a platform where **Clients** contract for the product; each client has one or more **Tenants**; each tenant is served by exactly one **Hive** (a Kubernetes deployment of Pragmatic's software running in the client's own infrastructure); inside a hive a tenant runs one or more **Environments**; each environment serves an **Application** (its graph/solution plus a browser-served UI). There are two admin tools, split by a hard trust boundary:

- **Platform Admin** — internal to Pragmatic, **never ships to a client**. It is the operator console: it provisions clients/tenants/hives, owns the signed image registry and release policy, runs the public channel that hives dial into, and gives read-only oversight across every hive.
- **Tenant Admin** — **ships as a container that runs inside one client's hive**, one per hive. It is that tenant's own control surface: it creates and runs environments, manages that tenant's users, and adopts new application versions. It is blind to every other tenant and hive.

They never share a screen, a session, or a database. Designing them as one system with two faces — not two unrelated apps — is the point of a shared foundation (§3).

---

## 2. The domain vocabulary (use these words exactly)

Consistent nouns are load-bearing; the backend's internal names are **not** the user-facing words.

| User-facing term | Means | Notes for copy |
|---|---|---|
| **Client** | The contracting organization | Platform Admin only. |
| **Tenant** | A customer workspace under a client | One tenant ↔ one hive. |
| **Hive** | The client-side Kubernetes deployment of Pragmatic | Platform provisions it; tenant lives in it. |
| **Environment** | A running workspace inside a hive that serves one app | **Always say "Environment."** The backend field `tenantId` actually identifies an environment — never surface the raw id as "tenant". |
| **Application** | The graph/solution + browser-served UI an environment serves | Reached at `https://<environmentId>.<baseDomain>/app/<tenant>/<app>/`. |
| **Version / Release** | A published, signed application-image version | Platform publishes; tenant adopts. |
| **Agent / Home channel** | The outbound connection the hive opens to Pragmatic | "Hive dials home." Pragmatic never connects inward. |
| **Adopt** | A tenant choosing to move an environment to a newer version | Not "deploy from Pragmatic" — the tenant pulls, the platform only offers. |
| **Bootstrap** | The one-time install artifact a client applies to stand up a hive | Carries a one-time token; shown once. |

Never show a raw secret value anywhere (token, key, credential). Secrets are referred to **by name/reference** with metadata (created, last rotated, status) and acted on with **Rotate / Revoke**, never **Reveal** (the one exception: a freshly-generated bootstrap token shown **once** at creation, §4.3).

---

## 3. Shared design foundation (both tools)

**Design system — the single source of truth:** the **Pragmatic Labs Design System** (Claude Artifact `XkyJGVRjDhwq8rKh52Pz7R`). Read `project/tokens.json` for exact token values (light + dark) and `project/README.md` for the brand book; reuse components under `project/components/<Name>/`. Verify every value against `tokens.json` before relying on the quick reference below.

**Brand quick reference (confirm against tokens.json):**

- Primary = **Signal Green `#2EA862`** (hover `#258A50`, press `#1B6B3D`, soft `#E2F3E9`). The brand is **green, not purple** — do not reach for a Material-3 purple.
- Accents: cyan `#3AA6B9`, plum `#7C6BAD`. Neutral ramp paper `#FAFAF9` … ink `#0A0A0B`.
- State colors: success `#4A8E3A`, warning `#C68A0E`, danger `#C24532`, info = cyan.
- Type: sans **Inter Tight**, mono **JetBrains Mono** (ids, tokens-by-name, logs, image digests), serif **Source Serif 4** (sparingly).
- **4px spacing grid**; radii 2 / 6 / 10 / 14 (never > 14) + pill; shadow sm/md/lg.

**Layout & chrome (shared skeleton, differently populated):**

- Left vertical primary nav; top bar with context (which Client/Tenant/Hive or which Hive/Tenant you are in), global search, environment/theme toggle, and the signed-in operator/user menu.
- Content area is a work surface: a page title row (breadcrumb + primary action), then the content. Detail pages use a header summary + tabbed or sectioned body.
- **Data density differs by audience:** Platform Admin is an operator tool — dense tables, keyboard-navigable, bulk selection, column controls, saved filters. Tenant Admin is for a client's administrator — the same components but calmer density, more guidance, fewer power-tools.

**Mandatory cross-cutting patterns (design these once, reuse everywhere):**

- **Status pills** for lifecycle/health/connection, using the state colors and an icon (never color alone — accessibility).
- **Secret-by-reference row**: name, type, created, last-rotated, status, with Rotate/Revoke actions. No value.
- **Destructive-action confirmation**: name-to-confirm for anything irreversible (delete environment, withdraw a version, revoke an agent).
- **Empty / loading (skeleton) / error / permission-denied** states for every list and detail (§6.4). Never a blank screen.
- **Async/long-running operation** feedback: provisioning, publishing, adopting, and rollouts are not instant — design progress, pending, and "we'll update when the hive next checks in" states.
- **Audit/history**: a consistent "activity" presentation (who did what, when) reused on relevant detail pages.
- **Toasts** for transient confirmations; an inline banner for persistent conditions (e.g. "This hive has not checked in for 2 days").

**Accessibility:** WCAG 2.1 AA. Full keyboard operability for the operator tool. Status never conveyed by color alone. Visible focus. Respect reduced-motion.

---

## 4. PLATFORM ADMIN (internal operator console)

### 4.1 Who uses it & their jobs

Pragmatic operations/engineering staff. Core jobs: stand up a new client and hive; publish and gate release versions; keep an eye on the whole fleet of hives; respond when a hive goes quiet or a rollout fails; rotate agent credentials; push upgrades of Pragmatic's own in-hive software. **They can observe tenant resources but never command them** (no break-glass into a tenant's environments or users).

### 4.2 Information architecture (primary nav)

`Fleet (home)` · `Clients` · `Tenants` · `Hives` · `Registry & Releases` · `Release Policy (Gating & Selection)` · `Agent Channel` · `Platform Components` · `Settings`.

### 4.3 Screens

1. **Fleet overview (home).** The cross-hive read model at a glance: every hive as a card/row with connection status (connected / last-seen Nhrs ago / never dialed in), health summary, environment count, current component versions, and outstanding issues (quiet hives, failed rollouts). Filters by client, status, health. This is the operator's morning screen — make the exceptions jump out.
2. **Clients — list & detail.** List of clients; create client; client detail shows its tenants and hives, contract/profile metadata, and activity.
3. **Tenants — list & detail.** Create a tenant (and bind it to exactly one hive — make the one-tenant-one-hive rule visible in the flow). Tenant detail links to its hive and its observed environment inventory (read-only).
4. **Hives — list & detail + Provisioning.** The heart of provisioning:
   - **Create/stand-up a hive → generate the Bootstrap artifact.** A wizard: choose client/tenant → generate a **one-time bootstrap** (install manifest/Helm chart + a one-time agent token + a pull-only registry credential + the trust-root **public** key). Present: a **download**, copy-paste install commands, the RBAC the client must grant, and the one-time token shown **exactly once** with a clear "you will not see this again" treatment. After generation, status = **Awaiting first dial-in**.
   - **Hive detail:** connection/home-channel status, agent identity & token (by reference; Rotate/Revoke), the components running (agent, tenant-admin, IdP versions), observed environment inventory + health (read-only, clearly badged "Observed — read-only"), and activity.
5. **Registry & Releases.** The signed image registry. List published versions with signing status, publish date, and adoption spread (how many hives are on each). Actions: **Publish** a new version (build → sign → publish; signing happens only here — show that trust fact), **Withdraw** and **Restore**. Version detail: manifest/digest (mono), signature/provenance, which hives adopted it.
6. **Release Policy — Gating & Selection.** The rules for which versions a hive is *allowed* to adopt, and the authoritative record of what each hive *did* adopt (adoption is recorded platform-side even though the roll runs in the hive). Design: a policy editor (per client/hive gating rules) and an adoption/rollout-report ledger with outcomes (adopted / gated-out / roll failed).
7. **Agent Channel.** The public listener hives dial into. Show registered agents, connection state, last-seen, and the token lifecycle (issue, rotate, revoke — hash stored only). Include a connection/event log. Make clear this is a separate public surface, not the operator API.
8. **Platform Components.** Pragmatic's own in-hive software (the agent, the tenant-admin container). Publish new component versions and watch the **automatic** push roll out across hives (this is the *only* thing the platform pushes down automatically). Per-hive upgrade status; failures surfaced on the Fleet screen too.
9. **Settings.** Operator profile/roles, platform-level configuration, audit log access.

### 4.4 Key flows (wireflow these)

- **Onboard a client → stand up a hive → first dial-in.** Create client → create tenant → generate bootstrap (one-time token shown once) → "Awaiting first dial-in" → hive appears connected on Fleet.
- **Publish a release → gate it → watch adoption.** Publish+sign a version → set/confirm gating → observe which hives adopt it over time.
- **A hive goes quiet.** From Fleet, spot a quiet hive → open hive detail → read last-seen + last telemetry → (no break-glass: the operator can only observe and, at most, rotate the agent token or re-issue a bootstrap).
- **Rotate a compromised agent token.** Revoke → re-issue (one-time) → confirm the hive reconnects.

### 4.5 Permissions

Design for at least two operator roles (e.g. full operator vs read-only observer). Read-only operators see Fleet, hives, and releases but cannot publish, gate, provision, or rotate. Show the permission-denied state (§6.4), do not hide-and-confuse.

---

## 5. TENANT ADMIN (ships into one hive)

### 5.1 Who uses it & their jobs

A client's own administrator, working **inside their own hive**, seeing **only their one tenant**. Core jobs: create and run environments; deploy and adopt application versions; manage their users and permissions; keep their environments healthy. They never see Pragmatic internals, other tenants, or other hives.

### 5.2 Information architecture (primary nav)

`Overview (home)` · `Environments` · `Users & Access` · `Releases (adoptable versions)` · `Settings` · `Connection status`.

The top bar states plainly **which tenant and hive** you are managing — there is nothing to switch to; that fixity is reassuring, design it as such, not as a disabled switcher.

### 5.3 Screens

1. **Overview (home).** This hive's environments at a glance with health and the application/version each serves; quick "create environment"; any adoptable-version offers waiting; the home-channel connection status to Pragmatic.
2. **Environments — list.** All environments in this hive: name, status (running/stopped/…), the app + version served, health, and the live URL. Create environment (name, template/type, target). Bulk-safe lifecycle actions.
3. **Environment — detail.** The workhorse screen:
   - Header: status pill, the served **application + version**, the live URL (`https://<environmentId>.<baseDomain>/app/<tenant>/<app>/`), lifecycle actions (Start / Stop / Restart / **Delete** with name-to-confirm).
   - **Application & version:** what's deployed now; **Adopt newer version** if an offer exists (see flow 5.4); deploy/redeploy the app's UI bundle; show the verify/rollout status (the pod verifies signatures fail-closed — surface a clear "verification failed, not served" state if a roll is rejected).
   - **Health & activity:** status over time, recent events, logs entry point.
   - **Connection/access info** for the environment.
4. **Adopt a version.** From the offers the platform makes available down-channel: pick a version → confirm → the roll runs locally in the hive → show progress and the outcome (adopted / gated-out upstream / roll failed, fail-closed). Make clear the tenant *chooses when*; the platform only *offers*.
5. **Users & Access.** The one tenant's identity, served by the in-hive IdP. Users list; **Create account**, **Disable account**; **Grant / Revoke role**; **Issue token** (shown once). A **Security model editor** for the Pragmatic permission model — CRUD permissions, field-level access, record sharing, and assignment — presented as an editable matrix/policy UI, not raw JSON.
6. **Releases (adoptable versions).** The list of versions this hive may adopt (offered over the home channel), with what's new and which environments are on which version. Entry point into the adopt flow.
7. **Settings.** Tenant profile; in-hive IdP configuration with sensitive values **by reference only** (CA, admin token — shown as references, never values); hive/base-domain info (read-only).
8. **Connection status.** The home-channel link to Pragmatic: connected/last-checked, the component versions running, and the last platform-driven component upgrade applied. Read-only and reassuring — the tenant doesn't manage this channel, they're just informed by it.

### 5.4 Key flows (wireflow these)

- **Create an environment and bring up an app.** Create environment → it provisions in the hive → deploy the application UI bundle → reach the live URL.
- **Adopt a newer version.** See an offer → review → adopt → local roll → confirm success (or see a fail-closed rejection and what to do).
- **Add a user and give them access.** Create account → grant roles → (optionally) tune the security model → issue a token if needed.
- **An environment is unhealthy.** From Overview/Environment detail, see degraded health → read events/logs → restart or redeploy.

### 5.5 Permissions

The tenant admin itself has roles (e.g. tenant owner vs a limited admin). Design the security-model editor to be legible to a non-expert administrator — explain what each permission grants in plain language, and warn before removing one's own access.

---

## 6. Cross-cutting UX requirements (both tools)

### 6.1 Make the trust boundary visible and trustworthy

The separation in §1 is the product's spine; the UX must make it felt, not just true underneath.

- **Platform Admin** shows tenant-owned resources as **"Observed — read-only"** wherever it displays environment inventory/health. There is no control affordance into a tenant's environments or users — don't design disabled buttons that imply a locked capability; design an observation view that simply has no such control, with a one-line explanation of why (read-only oversight, no break-glass).
- **Tenant Admin** never implies the existence of other tenants/hives or of Pragmatic internals. No cross-tenant navigation, no "platform" section.
- **"Hive dials home"** is a status the user reads, never a connection the user opens. Design it as health/telemetry, with graceful "hasn't checked in" messaging rather than an error.
- **Secrets by reference only** (§2). The only once-shown secret is a freshly generated bootstrap token / issued user token, with an unmistakable "copy now, shown once" treatment.
- **The only automatic down-push** is Pragmatic upgrading its own in-hive components — surface that to the tenant as an informational "component updated by Pragmatic" note, and to the operator as a controllable rollout.

### 6.2 Content & tone

Operator tool: terse, information-dense, assumes expertise. Tenant tool: plain-language, explains consequences, assumes a capable but non-internal admin. Error messages say what happened and the next step; they never leak internal error text, IDs of other tenants, or secret material.

### 6.3 Notifications & async

Provisioning, publishing, adopting, rollouts, and component upgrades are asynchronous and sometimes depend on the hive's next check-in. Design: optimistic submission → pending/in-progress → resolved, plus a durable place to see outstanding async work. Never present an async action as if it completed synchronously.

### 6.4 States matrix (required coverage)

For each key list and detail screen, design: **loading** (skeleton), **empty** (first-run, with a clear primary action), **populated**, **error** (retryable, no raw internals), and **permission-denied** (explains, offers who to ask). Deliver these as an explicit matrix, not scattered through the mockups.

### 6.5 Responsiveness & density

Desktop-first at 1440px; usable at 1024px (tables collapse gracefully, nav can condense). Provide a dense and a comfortable table variant and say where each is used.

---

## 7. Deliverables & acceptance

**Deliver:**

1. IA/sitemap + primary-nav design for each tool.
2. Wireflows for every flow in §4.4 and §5.4.
3. Hi-fi interactive prototype covering every screen in §4.3 and §5.3, built on Pragmatic tokens, in light and dark.
4. The states matrix (§6.4).
5. The written UX rationale (IA decisions, trust-boundary treatment, open choices you resolved).

**Acceptance checklist (your work is done when):**

- [ ] Every screen in §4.3 and §5.3 exists, in light and dark, using verified `tokens.json` values (green brand, Inter Tight, 4px grid, radii ≤14).
- [ ] The vocabulary in §2 is used exactly; no raw `tenantId`-as-"tenant"; "Environment" everywhere it applies.
- [ ] No secret value is ever displayed except the once-shown bootstrap/issued token, which carries a "shown once" treatment.
- [ ] Platform Admin presents tenant resources as read-only observation with no command affordances; Tenant Admin reveals nothing cross-tenant.
- [ ] Provisioning (bootstrap, one-time token, awaiting-dial-in) and the adopt/roll/fail-closed flows are fully designed, including async/pending states.
- [ ] Every key list/detail has loading/empty/error/permission-denied designed.
- [ ] WCAG AA: keyboard operability (operator tool), non-color status, visible focus, reduced-motion respected.
- [ ] A reviewer who has never seen the product can tell, from the UI alone, that these are two separate applications across a trust boundary.

## 8. Non-goals

End-user application runtime UI; the IdP's own login pages; marketing/onboarding; mobile-first layouts; billing; any capability not enumerated above. If a screen seems to need one of these, note it in the rationale rather than designing it.
