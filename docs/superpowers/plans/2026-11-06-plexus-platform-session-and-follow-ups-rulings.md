# Rulings made while building Plan C (Plexus platform session and in-hive follow-ups)

Source: the SDD ledger. Each line: what was decided, why, and the cost if wrong. Repos: pragmatic-server
(feat/in-hive-follow-ups-c), pragmatic-protocol (feat/relay-transport-detail), Plexus (feat/platform-session-follow-ups).

## Pre-flight

- Ruling: accept all 21 recommended pre-flight rulings as written; they follow the spec and the code after Plans A and B - cost if wrong: local rework in the named task.
- Ruling (D1): a non-reconnecting PragmaticClient (the way Plexus dials the relay) never rejected an in-flight request on close, so a console retired mid-call would have hung. pragmatic-protocol now rejects lost requests with ConnectionLostError, moves to Closed and reports `CloseCode()` - cost if wrong: none.
- Ruling (D2): the retired-console live test uses the typed console address, because a hive without a console setting is no longer discovered - cost if wrong: none.
- Ruling (D3): the platform step signs in at the platform IdP with the platform-side Owner's own credentials; fetching them is an Owner reset, asked of the user first - cost if wrong: none.
- Ruling (D21): the stored console part's tenant-plane address is named `PlatformSignInUrl`, so it does not collide with the control-plane Platform address or the legacy `TenantPlaneUrl` migration field - cost if wrong: none.

## Tasks

- Ruling (Task 7): reattaching a stored platform part to a new console sign-in requires the same TenantId and Email, so a different person signing in to the same console never inherits another's platform session. When the platform Owner's email differs from the console one, signing in to the console again drops the platform part and the user repeats the platform step - cost if wrong: one extra platform sign-in.
- Ruling (Task 7): the platform commit re-checks, inside the serialised store step, that the console part it was signed in for (by token) is still there; a platform part counts only beside a console part of its own tenant - cost if wrong: none.
- Ruling (Task 9): a 503 retired body reads as ConsoleRetired for both sources; the platform never sends that body, so it is inert there - cost if wrong: none.
- Ruling (Task 10): `TargetIdentity.RefFrom` is the one IPC validator for a target; the older runtime-live-loop e2e spec was also moved to a console target, since it would have been refused live - cost if wrong: none.
- Ruling (Task 13): `AttemptConsoleSignIn` takes the isolated profile and refuses any other, so a retired check that unexpectedly succeeds cannot store a session in the developer's own profile - cost if wrong: none.
- Ruling (Task 14 and G3): the relay hold is not idle on the wire, because the server pings every 30 s. It stays as the end-to-end evidence the spec asks for (a relay survives a long gap through the real Ingress), and the live run also read the console Ingress timeouts - cost if wrong: none.

## Final review

- Ruling (I1): when main drops an expired platform part it emits Changed (only on a visible change, and before it ends the token, which is not awaited), and the account dialog refreshes the state when it opens - cost if wrong: none.
- Ruling (M1): the platform part keeps the expiry issued at sign-in as its local expiry, as the console part already does - cost if wrong: a platform re-sign-in after 7 days although the server would have extended the session.
- Ruling (M2): a failed environment no longer raises the `platformEnvironments` discovery mark - cost if wrong: none.
- Ruling (M4): the fixed G1 sentences ("... Create it again in the tenant console.") stay as the spec has them for both sources - cost if wrong: one sentence slightly imprecise for platform targets.
- Ruling (fix wave): a duplicate Offered emit after a restart is accepted (nothing visible changes); a dropped expired platform token is also ended at the platform, so no released token stays live - cost if wrong: none.
- Ruling (declined items): accepted as the reviewer judged. A dormant platform part stays on disk until sign-out or expiry. pragmatic-protocol is consumed by link, so no version bump (publishing is out of scope). Ws auto-pong stalls predate this plan - cost if wrong: none practical.

## Live run (docker-desktop, 2026-11-07)

- Ruling (Step 3): no operator route creates environments, so `smoke-plat` was created through the tenant plane's `/tenant-api/environments` as the platform Owner (the product path) - cost if wrong: none.
- User decision: the platform's local dev IdP (https://host.docker.internal:12101) uses the CA `pragmatic-idp-dev-ca`, which `dev-ca-trust.ps1` refuses to trust in Windows because it is not name-constrained. The e2e helper's own Chromium pins exactly that IdP's server key (`PLEXUS_IHC_PLATFORM_IDP_CERT_FILE`, `--ignore-certificate-errors-spki-list`); the Windows trust store was not touched. The console leg still proves OS trust.
- Finding: the local platform IdP container (created 2026-11-03) ran a stale image without any-port loopback matching, so the IdP answered "redirect_uri is not registered". Removing the container let the control plane recover it on the same port and volume with the current image; no data was lost.
- Result G1: graph created through the console's tenant-api (201) and listed; Plexus contributed to it, and contributing to a missing graph gave the exact not-found sentence.
- Result G2: with the hive's console setting removed, the console was refused on its next ticks; `/desktop/targets` answered 503 `console-not-registered`, `/desktop/console` 200, and Plexus refused the typed sign-in as `console-retired` with no browser opened. After restoring, the console re-registered (`/desktop/targets` 401) and the main run passed again.
- Result G3 (closed, no manifest change): the console Ingress has no timeout annotations and nginx renders `proxy_read_timeout 60s` / `proxy_send_timeout 60s`; a relay held 150 s through it answered the second ListGraphs with no close code.
- Result G4: discovery marked `platformEnvironments: true`, the dialog offered the platform step, the platform sign-in completed, and Targets listed `smoke-ihd` (console) and `smoke-plat` (platform), whose graph listing answered.
- Final gates: a pre-existing flaky protocol test ("OnBuildStateChanged ... survives reconnect", failing 5 of 5 on master too) slept a fixed 20 ms while the first notification takes 24-40 ms to arrive; it now waits for each notification (bounded), and the suite passes 114/114.
- Teardown: graph, both environments, the console and its kept resources, ingress-nginx and the console dev CA were removed, and the temp credential files deleted.

## Open follow-ups (asked of the user)

- The local platform IdP's dev CA is not name-constrained, so it cannot be trusted in Windows the safe way; a name-constrained CA would let the platform leg prove OS trust like the console.
- A running local IdP container is reused even when the IdP image has been rebuilt; the reuse check could compare the container's image with the current one.

## Rule breaches (verified harmless)

- Tasks 4 and 8 and the fix-wave pin change: some new tests were written alongside the code and not run red first; each was later shown to fail against a deliberately broken build or a red run.
