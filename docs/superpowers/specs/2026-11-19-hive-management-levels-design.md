# Hive management levels, enrolment and pull-only management — design

Status: the target picture, agreed with the owner on 2026-11-19 in conversation. Design from the full target first;
the configuration of any particular deployment (an MVP) is derived from it afterwards (§10), never the other way
round. It supersedes the "remote provisioning targets" item (decision D28 in the deployment records) and the push
paths described in the earlier hive specs. Where it touches images it defers to
`2026-11-09-platform-images-design.md`.

## 1. Intent and why

Customers run their Pragmatic hive either **in their own Kubernetes cluster** (bring your own hive) or **on our
machines** (SaaS). Both must feel effortless to set up, and a serious buyer must be able to trust it: **the platform
never holds a credential that lets it act inside a customer's cluster.** Owner: "big fat no, otherwise nobody
serious purchases it from us. If a client chooses to bring their own hive, they know what they're doing; we help
make the experience maximally smooth and impose no controls, just quality guardrails."

The platform keeps growing in machines ("realistically we can run only one hive on hive-laptop, so I am going to
be adding more machines"), so hosting our own hives must scale by adding machines, with nothing cut.

## 2. Governing principle

> The customer owns the cluster. The platform never holds a credential into it. A hive only ever reaches out.
> We make it smooth and back it with quality guardrails, never controls.

The principle protects **customers' clusters**. On our own machines (§7) we are root on the host anyway, so the
platform manages SaaS hives by push (owner, 2026-11-19). Machines still reach out to enrol and to take placements.

## 3. Goals, non-goals, anti-goals

**Goals**
- Three management levels per hive, chosen by the customer (§4).
- A self-service journey from website registration to staff signing in, with no platform operator in the loop (§5).
- One install artefact, the **management engine**, for every connected hive, ours included.
- Every action the platform takes on a hive arrives as **intent the hive pulls**, applied by software inside the
  cluster with permissions the customer granted and can read.
- SaaS hives on our machines run the same engine, managed by push from the platform. Adding a machine is "install,
  enrol, done".
- The platform admin runs no containers anywhere.

**Non-goals**
- Pricing, licensing and payments (postponed, D12). §9 records where they would attach.
- The data permission model inside environments (the platform security architecture design covers it).

**Anti-goals** (a failure even if it works)
- Any kubeconfig, service-account token or cloud credential for a customer's cluster on the platform's side.
- Platform software inside a hive that can read or change the customer's environment data or applications.
- A Standalone hive that needs us to run, phones home, or breaks when we disappear.
- A step in the customer journey that waits for a Pragmatic employee.
- A container engine reachable from the platform admin (no Docker API, no SSH into machines).

## 4. The three levels

**Names (owner, 2026-11-19): the levels are named, not numbered:** **Standalone**, **Enrolled**, **Delegated**; SaaS
hives on our machines (§7) are **Hosted**.

| Name | Platform's reach over a hive's configuration and updates |
|---|---|
| **Standalone** | none: updates are published; the customer fetches and applies them |
| **Enrolled** | announces updates; the customer approves; the hive validates and applies |
| **Delegated** | manages by intents ("place, never look"); the hive pre-checks against its own configuration and reports results; the platform never reads the configuration or any data |
| **Hosted** | everything (our machines): may read a copy of the configuration, pre-check upgrades centrally, gather telemetry, roll out centrally |

At every level the configuration's source of truth is the configuration repository in the tenant admin console, in the
tenant's home hive; only the platform's reach differs.

| | Standalone: do it yourself | Enrolled: our engine, your hands | Delegated: we manage the hive |
|---|---|---|---|
| Install | our scripts and charts, run by the customer | the management engine | the management engine |
| Connected to the platform | **no**, fully standalone | yes, enrolled | yes, enrolled |
| Who approves changes | the customer, by running newer charts | the customer, in the engine's UI | delegated to the platform |
| Platform software may touch | nothing (none runs) | what the customer approves | the hive's control layer only, **never data or applications** |
| Guardrails | the scripts' own checks | preflight and health in the engine's UI | the same, plus drift detection |

- **Enrolled vs Delegated is "who presses approve", not different software.** A customer may switch at any time in
  the engine's UI.
- **Standalone means fully standalone.** No enrolment, no dial-home, no hive record on our side. It must run air-gapped:
  - the images come from a public registry or an offline bundle;
  - trust comes from our **published** signing public key; nothing is checked online;
  - sign-in is the hive's own, upgrades are the customer pulling newer charts;
  - the desktop app connects to it by URL (no discovery through us).

  Moving up to Enrolled later means installing the agent and enrolling; data and accounts carry over.
- **Delegated's boundary: "place, never look"** (owner, 2026-11-19). The agent may create and update environment
  workloads: deploy applications, set versions, restart, create an environment's namespace. It can never:
  - read Secrets;
  - exec into pods;
  - port-forward or proxy into them;
  - read volumes or any environment data.

  "No access to data and applications" means it can place applications but never look inside them. This is
  enforced in the cluster, not promised: the chart's permission grant, plus an admission policy that denies those
  verbs to the agent's identity. The customer can read and audit both.

## 5. The customer journey (bring your own hive)

| # | Action | Where | Who |
|---|---|---|---|
| 1 | Register | the website (public) | the customer |
| 2 | The website checks the data and the platform creates the client and tenant records | website → platform, through the public edge | automatic |
| 3 | Install the management engine: one public, secret-free command (a chart from our registry) | the customer's cluster and terminal | the customer |
| 4 | The engine starts, runs its preflight guardrails and serves its console inside the cluster | the cluster | automatic |
| 5 | In the engine's console, "connect this hive to Pragmatic": they sign in with the account from step 1 and pick the tenant and level | engine console ↔ platform | the customer |
| 6 | Enrolment: the hive creates its identity in the cluster; the platform records the hive under the tenant (public half only); the engine adopts the platform's trust root | engine ↔ platform, through the edge | automatic |
| 7 | The hive pulls the engine's components by digest and reports health | hive ↔ platform | automatic (approved per level) |
| 8 | Sign-in is set up per the tenant setting (§6) and the customer verifies their email domains | engine console, platform | the customer |
| 9 | Their staff sign in and work; the desktop app finds the hive from the email domain | the hive, the desktop app | staff |
| 10 | Live operation: versions, rollouts, environments, repairs, all pulled (§5.1) | hive ↔ platform | per level |
| 11 | Leave: the customer uninstalls; the platform marks the hive gone and releases its domains | the cluster, platform | the customer |

- **The website never deals with clusters,** and the platform never creates a hive record ahead of enrolment.
- **The registration call** reaches the platform through the public edge as a narrow "register this client" call.
  The admin stays private.
- **Creating a tenant is only a record.** No per-tenant sign-in container exists any more (§8).

### 5.1 Pull, not push

Every action that today is a push (the admin running `kubectl` against a cluster) keeps its capability. Only the
actor changes.

| Action | Today | Target (Enrolled and Delegated) |
|---|---|---|
| Install or upgrade the console and sign-in | the admin applies manifests with `kubectl` | the platform publishes "component X at version V" for the hive; the agent pulls it and applies the same manifests in-cluster |
| Create an environment | the admin starts a container or applies a workload | the request is recorded on the platform; the agent pulls it and creates the environment in the hive |
| Roll out a version | rollouts are already pulled by the agent | unchanged |
| Repair or restart | the admin runs `kubectl` | the agent compares desired with observed state and acts |

- In **Enrolled** every intent waits in the engine's UI for the customer's approval. In **Delegated** the agent applies
  it directly.
- The manifest building and install steps that live in the admin today move into the agent. The admin sends
  intent, never commands with credentials.

## 6. Sign-in

- **The hive's own sign-in always issues logins** for its console, environments and the desktop app: one issuer
  per hive, at every level.
- **A tenant setting chooses where people authenticate upstream:**
  - local hive accounts;
  - the customer's corporate identity provider (OIDC, e.g. Google Workspace or Entra);
  - central **"Sign in with Pragmatic"** (the hive's sign-in brokers to our central login);
  - or a combination.
- Only when "Sign in with Pragmatic" is chosen do those staff identities live with us, and the customer opted in.
  Standalone offers the first two only.
- **The account from website registration** is the customer administrators' account for managing their
  subscription and enrolling hives. It is not their staff's working login.
- **The registration account lives in the central login** (Google Identity Platform, the deployment's "one login"),
  so central login (roadmap step 3) is a dependency of enrolment. *(Builder check: answered from the deployment
  records.)*
- **Discovery:** the customer proves ownership of their email domains once. Discovery then points those addresses
  at the hive's console. Verified domains are the only identity-related data we keep for a non-brokered tenant.

## 6b. The console's address (owner, 2026-11-19: the customer's choice)

Chosen at install and changeable later; the guardrails check whichever is chosen (name resolves, certificate valid,
ingress answers).

| Option | DNS | Certificate | Traffic |
|---|---|---|---|
| Their own domain (`pragmatic.acme.com`) | theirs | theirs (their cert-manager or their own certificate) | straight to their ingress |
| Our subdomain (`acme.hives.pragmatic-tech.ai`) | we publish a record to the ingress address the hive reports | the hive's own cert-manager requests it; the platform answers the DNS challenge for that one name. The private key never leaves their cluster | straight to their ingress |
| Our subdomain, private cluster (no public ingress) | points at the edge | as above | through the edge relay with TLS passthrough (§7); the edge never sees plaintext |

- Standalone offers their own domain only.
- The relay is therefore a shared edge component (bring-your-own private clusters and SaaS hives), not SaaS-only.

## 6a. Ownership of state, credentials and reports (my calls, from §2)

- **The hive is the source of truth for its environments at every level.** The engine's console creates and changes
  them locally (as in Standalone). In Enrolled and Delegated the platform may *request* changes as intents, and the hive keeps
  the platform's view current through reports. So moving from Standalone to Enrolled needs no import, and drift is always
  measured against the hive's own desired state.
- **No credential ever travels to the platform.** Today's platform features that reach inside environments move into
  the engine's console, and intents never return a credential. These features are:
  - acting as an environment's Owner through tunnels (`admin-proxy`);
  - holding the in-hive sign-in's admin token on the platform;
  - the Owner password reset that hands a password back to the operator;
  - reading an environment's secrets.
- **What a hive may report** is the state of its own engine components and, per environment, its name, readiness and
  deployed version. It never reports logs, application error text or anything from environment data. The engine's UI
  shows the customer exactly what is sent.
- **Hives per tenant:** a tenant may have several hives (bring-your-own and SaaS, or one per region). Exactly one is
  its **home hive**, which hosts the tenant's console and sign-in, and discovery points at it. Further hives join the
  home hive's sign-in.
- **Existing hives:** none migrate. The deployed platform starts clean (D25), and development hives on the laptop stay
  development hives. Enrolment is for new installs. *(Builder check: answered from D25.)*

## 7. SaaS: platform-hosted hives on our machines

- **A SaaS hive runs the same management engine under the customer's tenant,** enrolled like any hive (its identity,
  trust root and discovery work the same way).
- **It is managed by push (owner, 2026-11-19).** The platform holds a credential for the clusters on our own machines
  and drives them directly, reusing today's install code. Why this doesn't weaken anything: on our machines we are root
  on the host, so an in-cluster "place, never look" boundary could not be enforced against us there anyway. A SaaS
  customer trusts us with their data the way they trust any SaaS provider. The pull path still exists, because
  bring-your-own Enrolled and Delegated hives need it; SaaS hives simply don't use it.
- **Host agent (chosen approach A):** each of our machines runs a small host agent, installed once and enrolled with
  a code from the portal, the same pattern as a hive. When a SaaS hive is needed, the platform records "host a
  hive for tenant T" on a machine with room. That machine's host agent pulls the request and acts:
  1. it creates the cluster locally (k3s on Linux, kind on a WSL machine);
  2. it installs the engine with an enrolment code, and the engine enrols under tenant T;
  3. it hands the platform a credential for that cluster, stored in the platform's secret store. The admin then reaches
     the cluster's API server over the mesh, so hosting machines are mesh nodes. *(My call: push needs a route in,
     and the mesh is how the platform already reaches its own machines.)*
- **How customers reach a SaaS hive (owner, 2026-11-19): the edge relays with TLS passthrough.** Each host agent keeps
  an outbound tunnel to the edge. The edge routes by hostname (SNI) into the right machine's tunnel without
  terminating TLS. It never sees plaintext and stays keyless, and machines can be anywhere, even behind home NAT.
  The cost: the edge carries customer traffic, so the relay is a new edge component with its own capacity limits.
  Rejected: machines serving publicly on their own 443 (every machine would need a public address, and NAT-bound
  machines could not host).
- The host agent reports capacity and health. Placement (which machine hosts which hive) is the platform's.
- **The host agent pulls placements;** the admin never logs in to a machine and holds no machine credential, only
  the cluster credentials of the SaaS hives (§8 risk: a break-in at the admin reaches every SaaS hive's cluster, so
  those credentials are scoped per cluster and rotate).
- **Rejected:**
  - B, the admin pushing over the mesh with Docker TLS or SSH: the admin would hold root-equivalent keys to every
    machine, each new machine needs per-machine plumbing, and it would be the system's only push;
  - C, an operator running a bootstrap script per hive: a person in the loop for every SaaS sign-up. It remains
    the manual fallback, since the host agent runs the same bootstrap steps.

## 8. Consequences for the platform

- **The admin never runs a container itself.** These disappear from the admin as separate products:
  - the per-tenant sign-in container (sign-in lives in the hive);
  - platform-run Docker environments (environments run inside hives);
  - creating kind clusters on the admin's own host (the host agent creates clusters);
  - installing the console with `kubectl` on customers' clusters (the agent installs it there; on SaaS hives the
    platform's push does).
- **The edge gains a relay** for SaaS hives' user traffic (TLS passthrough, §7). It still terminates nothing for
  hives and holds no key.
- **The admin's job:**
  1. records;
  2. answering hives' and host agents' pulls (intent, versions, trust, discovery);
  3. placing SaaS hives on machines;
  4. pushing to SaaS hives' clusters (today's `kubectl` install and rollout code).
- **Image trust uses registry digests** (index digests from the release catalogue), not a local Docker engine's
  image ids. Hives pull by digest from the platform's registry: GitHub's container registry today, the platform
  proxy later per the images spec.
- **Hive identity is generated in the cluster at enrolment.** The platform keeps the public half. That replaces
  today's one-time token typed into `kubectl`.
- **The development laptop** keeps whatever local shortcuts it needs, but the product paths above are the only ones
  the deployed platform uses.

## 9. Constraints and context

- **Earlier decisions this keeps:**
  - D21: the keyless public edge in front of a private admin. Hives, host agents and the website reach the platform
    only through the edge.
  - D23: secrets reach services as files from a host-side sync.
  - The platform images design: images by digest; GitHub's registry now, the platform proxy later.
- **Earlier decisions this supersedes:**
  - The spec "control plane on frontdoor" §6.1: Docker targets reached over the network with TLS client
    certificates, and Kubernetes targets via kubeconfig. Replaced by §7.
  - D28 (remote targets as a subsystem): replaced by the host agent.
  - D26's "the deployed admin drives remote targets": it now places hives, and the hives and machines act.
- **Website and self sign-up** were postponed (D12) but are designed for here, as the owner directs.
- **Pricing and payments** (postponed) would attach to the client record created at registration and to the level
  chosen at enrolment.
- **Code style** in pragmatic-server: OOP, no module-level functions, Allman braces, PascalCase public members, no
  inline string literals, tests in `tests/` folders.

## 10. From this design to work

**Sub-projects, in dependency order** (each gets its own design detail and plan). Central login (roadmap step 3)
comes before enrolment, because the registration account lives there:
1. **The management engine as one install artefact.** A chart containing the agent, console and sign-in, with images
   by digest, preflight guardrails, and Standalone mode.
2. **Enrolment.** "Connect this hive" in the engine's console, with sign-in by the registered account, the hive
   identity generated in the cluster, the hive record created at enrolment, and trust-root adoption.
3. **Pull-only management.** Today's push paths move into the agent as desired-state handling, with an approval
   queue in the engine's UI (Enrolled) and delegation (Delegated).
4. **Registry-digest image trust** across signing, verification and rollouts.
5. **Tenant sign-in setting:** local accounts, corporate OIDC, and "Sign in with Pragmatic" (with roadmap step 3,
   the central login).
6. **Website registration** through the edge.
7. **Host agent, SaaS placement and push management of SaaS hives** (reusing today's code) on our machines.
8. **The edge's TLS-passthrough relay and hive subdomains** (DNS records, DNS-challenge answering): shared by SaaS
   hives and private bring-your-own clusters.
9. **Retire the admin's container paths** (§8).

**MVP derivation:** a separate, explicit step after this design is approved. It decides which sub-projects the
current deployment (staff alpha) needs first, and in what reduced configuration.

## 11. Left to the builder

- The chart tooling (Helm or another standard) and the chart's layout.
- The hive identity's key type and how requests are authenticated with it.
- The wire format for intent, approval and reports.
- The engine UI's approval experience.
- The exact Kubernetes permission grant for Delegated.
- Which cluster technology the host agent uses per machine kind.
- Placement rules.
- The registration call's shape and the website's checks.
