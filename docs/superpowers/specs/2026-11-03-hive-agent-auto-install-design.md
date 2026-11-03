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
  cluster exists and load the agent image, with a 20 min image-load timeout; Attach: no-op),
  `ApplyingAgent` (bundle manifest via `IKubectl.Apply`, stdin), `StoringToken` (a fresh token is
  minted, `NewAgentToken`; a v1 Secret manifest carrying it is applied server-side via
  `IKubectl.ApplyServerSide` on stdin, so no last-applied annotation copies it; only then is its
  hash committed, `CommitAgentToken`, so a failed store leaves the previous token valid; the token
  is dropped from memory right after), `RestartingAgent` (`IKubectl.RolloutRestartSelector` with
  the bundle's hive selector, restarting every deployment that reads the Secret - the agent and,
  when installed, the tenant-admin pod - so a reinstall picks the new token up),
  `WaitingForCheckIn` (poll hive observations until a snapshot newer than the moment the restart
  returned arrives; default timeout 15 min - a fresh cluster loads the ~2 GB image first). Before
  each step the hive must still exist; a hive deleted mid-install stops it (Failed).
- While an install runs for a hive, reissuing its token (`rollout-registration`) and deleting the
  hive are refused (409), since either would undo the install.
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

## Uninstall on delete

Added 2026-11-03 (branch hive-delete-uninstall-agent). `DELETE /api/hives/:id` runs fail-closed,
under the per-hive operation lock, in this order:

1. Remove the agent from its cluster (`HiveAgentUninstaller`, attached Local hives only), all with
   `--ignore-not-found` so a half-installed or hand-removed agent deletes cleanly:
   `kubectl delete -f -` (stdin) of `HiveBootstrapBundle.RemovalManifest` (every bundle object
   except the shared `pragmatic-system` Namespace, plus the token Secret, names derived from the same
   render as the bundle); `kubectl delete -f -` of `TenantAdminBootstrap.CredentialRemovalManifest`
   (the tenant-admin's IdP CA and IdP admin-token Secret copies, by name, since older clusters carry
   them unlabelled; only when the tenant's tenant-admin Deployment is absent or labelled for THIS
   hive, so deleting another hive of the same tenant on the same context leaves them); then `kubectl delete deployment,service,serviceaccount,secret -l
   pragmatic/hive=<id> -n pragmatic-system` (the agent, and the tenant-admin pod with its Service,
   ServiceAccount and labelled credentials such as a pull secret; bootstrap labels every Secret it
   carries for the hive except the seed). Kept on purpose, together: the tenant-admin data PVC and
   its seed Secret (the master key that decrypts it); the delete names those that exist (and only
   when this hive owns the tenant-admin) in its response (`retained`) and in the audit entry's note
   (shown on the portal's activity entry). Provisioned (kind) hives skip this step: their whole
   cluster is destroyed next, agent included. Other backends' clusters are never touched.
2. `DestroyHiveCluster` (provisioned hives), 3. `DeregisterHive` (the agent token stops verifying),
   4. delete the record.

A failure before step 4 leaves the record for retry. An uninstall failure (kubectl) answers 409
with `code: "agent-uninstall-failed"` and "Could not remove the hive's agent from its cluster:
<redacted kubectl reason>. Fix cluster access and retry, or delete anyway to remove only the
platform record."; a kind cluster that cannot be destroyed (kind / Docker down) answers 409 with
`code: "cluster-destroy-failed"` and its redacted reason. Any other failure is a server error.
Delete anyway is `DELETE /api/hives/:id?force=true`: it skips steps 1 and 2 (the agent may remain
in the cluster, locked out because its token is revoked; a kind cluster may be left behind; the
response's `notice` says which) and is audited with the fixed `?force=true` marker on the hive
path (no other query text is ever stored). The portal offers it on the hive page after either
failure, behind its own confirm-by-name dialog, and the hives list then shows what was kept or
may have been left behind.

Hive ids become Kubernetes names and the `pragmatic/hive` label value, so they must be lowercase
RFC 1123 labels (a-z, 0-9, '-', starting and ending with a letter or digit) of at most 34
characters - the tightest id-derived limit: a provisioned hive's kind cluster name
`pragmatic-hive-<id>` is capped at 49, and the agent name `pragmatic-hive-<id>-agent` is also its
app label value (63). One constant (`K8sManifestBuilder.HiveIdMaxLength`, mirrored by the portal's
`HiveOptions.IdMaxLength`); enforced on create and provision (400), mirrored in the portal, and
refused again by the selector builder, the installer and the uninstaller, so a selector like
`pragmatic/hive==b` can never match another hive.

Legacy hives: a hive stored before this rule with an id that breaks it (uppercase, `_`, `.`, other
characters, or longer than 34) gets no automatic install and no bootstrap commands, and its delete
refuses the cluster uninstall: remove it with Delete anyway (`?force=true`), clean its cluster by
hand if needed, and recreate it with a valid id.

Pull credentials: bootstrap labels the pull-credential Secret with the bootstrapping hive, so the
last hive to bootstrap a given Secret name owns it and its delete removes it. Sharing one
pull-secret name between hives is not supported.

## Left to the builder

Exact copy, the polling helper's shape, test fixtures. Keep the existing conventions (OOP,
Allman, hoisted literals, enums, VMs extend Observable, tests in tests/, match file EOL).
