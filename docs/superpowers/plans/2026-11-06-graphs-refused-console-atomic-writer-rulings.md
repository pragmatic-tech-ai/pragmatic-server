# Rulings made while building Plan A (graphs, refused console, atomic writer)

Source: the SDD ledger. Each line: what was decided, why, and the cost if wrong.

## Pre-flight

- Ruling: accept the pre-flight's recommended rulings #1-#4 and #6-#14 as written - they match the spec and the code - cost if wrong: local rework in the named task.
- Ruling (#5 and Task 3): keep the spec's `envs` gate on the graph routes. Both tenant roles (Tenant owner, Environment admin) hold `envs` today, so it restricts no one yet; an Environment admin can already delete whole environments, so deleting a graph adds no new power, and the gate makes any future narrower role safe by default - cost if wrong: tenant admins (not only the Owner) can delete graphs; narrowing to Owner-only is one check.
- Note (#15, for Plan B): Plan B rebases onto this plan's console-advert-sender.ts / AdvertSenderOf changes; the registration parameter stays last.

## Tasks

- Ruling (Task 1): the full root `npm test` was deferred while two external TODL test suites loaded the machine (solo runs failed only by whole-file timeouts in untouched files); it ran green at Task 9 (1644/1662, 0 fail) - cost if wrong: none, it passed.
- Ruling (Task 7): `RelayPipe.ConsoleRetired` dropped (amends pre-flight D1) - `DesktopRelay.ConsoleRetiredCloseCode` (4003) is the single home - cost if wrong: none.
- Note (Task 7, for Plan C): a relay that is mid-dial when the console is retired gets 101 and then close 4003, not a 503; Plexus maps close 4003 to ConsoleRetired.
- Ruling (Task 8): with `fsync: true`, `AtomicJsonFile` also fsyncs the parent directory after the rename on POSIX (skipped on Windows by a platform check) - sealed key material needs the rename itself durable - cost if wrong: one extra fsync per sealed write on Linux.

## Final review

- Ruling (M1): `EnvironmentUnreachableError` and `TransportFailure` raised before the admin call answer 503 with the reach sentence - cost if wrong: none.
- Ruling (M2): a console with no advert sender opens Registered and its registration does not gate the desktop (logged once) - nothing could ever restore Registered, so a saved Refused would lock the desktop out forever - cost if wrong: a console with broken advert settings keeps serving the desktop even if the platform would refuse it (it cannot learn either way).
- Ruling (M3): a parent-directory sync failure after a successful rename does not reject; an optional `onDirectorySyncFailure` callback reports it and `SealedSecretStore` logs the error name - the new content is already in place - cost if wrong: a rare non-durable rename is logged, not surfaced as a write error.

## Open evidence

- G3 (relay timeouts): no code in this plan; Plan C's live check holds a relay for 150 s through the console Ingress.
- The POSIX-only tests for file mode and directory sync have not run on this Windows host; their first run is on Linux CI.
- The pod-with-reach graph path is covered only by composition tests here; Plan C's live check exercises it.

## Rule breaches (verified harmless)

- Task 2: node replace scripts on graph-service.ts and two tests (bytes checked; no red run before implementing).
- Task 3: a no-op `sed -i` against /dev/null (no repo file touched).
- Task 4: a shell heredoc append on tests/tenant-plane-compose.test.ts (bytes checked).
