# Rulings made while building Plan 3 (in-hive desktop API, relay, Owner reset, Plexus sign-in)

Source: the SDD ledger. Each line: what was decided, why, and the cost if wrong. Code spans two repos: this repo (branch in-hive-desktop-api) and Plexus (branch in-hive-console-sign-in).

## Pre-flight

- Ruling: accept all 25 pre-flight recommendations as written. D8, D9, D19, D21 and D22 and the out-of-pod relay ruling are recorded in the spec's decisions (Task 3 commit).
- Note: the follow-up for a console whose advert is refused must say "refused (401 or 409)": a forced hive delete deregisters the token (401).

## Tasks

- Ruling (T7): SignIn re-discovers when the chosen tenant is missing from the cached discovery answer, not only when the platform or email differ - a stale cache must not report NoAccount for a tenant the platform knows - cost if wrong: one extra discovery call.
- Ruling (T8): the text-variant link Buttons keep HorizontalAlignment = Left - it is how link buttons sit in a StackPanel, not a defect - cost if wrong: one attribute.
- Ruling (T9): the live smoke ran from the unmerged Plan 3 branches (on top of merged Plans 1-2 and Plexus main) - the final review should see the smoke's fixes before merging - cost if wrong: none, the merge is a fast-forward of the same commits.
- Ruling (T9): the Plexus e2e helper gains a headless-Chromium IdP leg (PLEXUS_E2E_IDP_LOGIN=browser; default http) because the in-hive IdP serves a JavaScript single-page login with no server form; it sets no ignoreHTTPSErrors, so the OS trust store is exercised - pre-flight #17's Node-http premise holds only for the control-plane IdP - cost if wrong: helper code only.
- Ruling (T9): the smoke's dev graph is created as a prerequisite (as the environment Owner, over a port-forward), because the in-hive console has no graph-create route - cost if wrong: none for the product; the gap is a follow-up.
- Ruling (T9): the two control-plane live specs (runtime-live-loop, sp1-plexus-smoke) were not re-run - with the console installed, discovery sends the tenant to the console (follow-up #22), and they need control-plane-tenant Owner credentials and Docker environments - cost if wrong: a regression on the control-plane relay path surfaces at their next operator run.
- Ruling (T9): spec steps 7 (desktop audit) and 8 (operator Owner reset) run outside the spec; both passed live (audit: Owner contribute, no Bearer; reset: a desktop token's targets went 200 -> 401 within 105 s and, on the final code, 151 s).

## Final review

- Ruling (I1): the platform tenant-plane fallback uses a scheme-only rule (https, or http on a loopback host) and may carry a base path; a tenant's own consoleUrl and a typed address keep ConsoleAddress (no path) - cost if wrong: a path-bearing console URL is refused, as before.
- Ruling (M2): typecheck:e2e joins the app typecheck; it covers only the in-hive spec, the scripted sign-in helper and e2e/support, because ten older e2e specs do not typecheck.
- Ruling (M8): the composed-console test spies on the relay the host serves rather than opening a real relay socket (that needs a running environment and an in-pod reach) - a mutation check confirms it fails if the relay is detached from the principals.

## Live-run lessons

- `docker build` does not reach Docker Desktop's Kubernetes node: load the image with KindImageLoader before (re)starting a console, or it runs old code.
- Fetching the Owner password through the operator route is itself an Owner reset: the console's follower revokes the Owner's sessions at its next advert.

## Rule breaches (verified harmless)

- T3: a shell heredoc append on tests/console-advert-receiver.test.ts (file stayed ASCII and LF).
- Final fix wave: one python edit on Plexus desktop-api-client.test.ts (file stayed ASCII and LF).

## Follow-ups offered to the user

- In-hive console graph management (create and delete graphs for its environments); the environment server should answer a contribute to a missing graph as a typed "graph not found", not "internal error".
- Move the 8 older JSON stores onto AtomicJsonFile.
- Make the ten older Plexus e2e specs typecheck, then widen tsconfig.e2e.json to the whole folder.
- From pre-flight: a console whose advert is refused (401 or 409) stops serving sign-in and the relay (#9); console Ingress WebSocket timeouts for long relay calls (#20); Plexus targets across the console and the platform tenant plane (#22); Plan 2's DNS TXT email-domain verification.
