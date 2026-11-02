# Hive agent auto-install (Platform Admin) - design

Date: 2026-11-03. Status: approved by the user in chat ("yes" to the proposal).

## Why

Standing up a hive today ends with a one-time token, a downloaded bundle and three `kubectl`
commands the operator runs by hand (bash only, because of `read -rs`). The user wants the app to
do this: no command line. For hives on clusters the control plane already drives (backend
`Local`, modes `Attach` and `Provision`), the control plane already holds cluster access through
`HiveOrchestratorFactory` and applies environment workloads itself, so installing the agent the
same way adds no new trust. Clusters the platform must never touch (future client-owned/cloud
hives) keep the manual bundle path.

## Goals

- Local hives: the wizard's last step installs the agent automatically and ends on "Connected",
  with live step progress, a clear error and Retry on failure.
- Hive page: one-click "Install agent" (doubles as reinstall/rotate: it always issues a fresh
  token and restarts the agent).
- The manual path (Download bundle, commands, Reissue token) stays available as a secondary
  "Install manually" option, and is the only path for non-Local hives.

## Non-goals / anti-goals

- No cluster credentials for client-owned clusters; no new backends.
- The token never reaches the browser on the automatic path, never appears in process
  arguments, logs, errors or responses.
- No fake progress: every step shown is a real step.

## Backend

New `HiveAgentInstaller` (admin/control-plane/hive-agent-installer.ts), one per control plane:

- `Start(hiveId): InstallStatus` - begins an install in the background; throws a typed error when
  the hive is unknown (404), not Local (409, "automatic install is not available for this hive"),
  the agent channel is off (409), or an install is already running for that hive (409).
- `StatusFor(hiveId): InstallStatus | undefined` - the latest install's state, in memory only
  (a control-plane restart forgets it; the hive's real state is still `lastSeen`).
- Steps, in order (enum `InstallStep`): `PreparingCluster` (Provision mode: ensure the kind
  cluster exists and load the agent image; Attach: no-op), `ApplyingAgent` (bundle manifest via
  `IKubectl.Apply`, stdin), `StoringToken` (`RegisterHive` issues the token; a v1 Secret manifest
  carrying it is applied via `IKubectl.Apply` on stdin; the token is dropped from memory right
  after), `RestartingAgent` (`IKubectl.RolloutRestart` on the agent deployment so a reinstall
  picks the new token up), `WaitingForCheckIn` (poll hive observations until a snapshot newer
  than the install's start arrives; default timeout 15 min - a fresh cluster loads the ~2 GB
  image first).
- `InstallStatus = { state: InstallState (Installing | Connected | Failed), step: InstallStep,
  startedAt, finishedAt?, error? }`. Errors are fixed operator-facing messages per step plus the
  already-redacted `KubectlError` text; never the token.
- `IHiveOrchestrator` gains `PrepareAgent(image: string): Promise<void>`: Kubectl driver no-op;
  Kind driver ensures the cluster and best-effort loads the image (reusing its existing private
  helpers).
- Routes: `POST /api/hives/:id/agent-install` -> 202 + status; `GET /api/hives/:id/agent-install`
  -> 200 status or 404 when none has run. Writes are audited by the existing middleware and are
  gated like the other hive writes (Full permission -> else 403).
- `HiveBootstrapDto` gains `autoInstall: boolean` (true for Local hives) so the portal can choose.

## Portal (admin/portal)

- Provision wizard, Bootstrap step: when the new hive's bootstrap says `autoInstall`, start the
  install and show the step list with the current step, then "Connected"; on failure the error,
  Retry, and an "Install manually" expander with today's bundle + commands (which needs a token:
  the expander's action reissues one and shows it once, as the hive page does today). The token
  from the provision response is not shown on the automatic path.
- Hive detail page: "Install agent" command (Local hives) with the same progress panel; the
  existing Reissue token + commands move under "Install manually". Non-Local hives keep today's UI.
- Progress is polled (2 s) from `GET .../agent-install`; polling stops when the page is left.

## Left to the builder

Exact copy, the polling helper's shape, test fixtures. Keep the existing conventions (OOP,
Allman, hoisted literals, enums, VMs extend Observable, tests in tests/, match file EOL).
