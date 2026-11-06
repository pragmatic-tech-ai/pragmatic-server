# Rulings made while building Plan B (DNS TXT domain verification)

Source: the SDD ledger. Each line: what was decided, why, and the cost if wrong.

## Pre-flight

- Ruling: accept all 23 recommended pre-flight rulings as written; they follow the spec's G5 and the code after Plan A - cost if wrong: local rework in the named task.
- Ruling (D7): the plan's "Plan A may run first, do not depend on it" constraint is stale; implementers worked from the current code - cost if wrong: none.
- Ruling (D1): the console's verify channel is attached in `TenantAdminServer.SenderFrom`, the path production's Compose takes, not in `AdvertSenderOf` as the plan said; a Compose test proves it - cost if wrong: none (the plan's place would never have run).
- Ruling (D5): the throttle checks, records and checks again, so exactly 10 lookups run per window and the 11th attempt is refused without a lookup - cost if wrong: none.
- Ruling (D6): Revoke is offered on every row that is not already Revoked, including contested ones, because revoke beats verification - cost if wrong: one condition.
- Ruling (D9): copy that said a domain takes effect only after operator approval now reads "A domain takes effect once the platform operator approves it, or once its DNS TXT record is verified and no other tenant claims it."; the tenant portal's pending prefix is "Not in effect yet: " - cost if wrong: copy change.
- Ruling (D10): on the console, a domain with no answer from the platform yet is not listed as pending; its state is unknown - cost if wrong: one condition.
- Ruling (D14): the daily re-check adds no shutdown hook (its timer is unref'd); a failed write counts as a failed check and logs the error name only - cost if wrong: none.
- Ruling (D15/D16): the agent channel answers 409 for both "console not enabled" and "domain not claimed"; a storage failure after an advert is stored is a 500 and stays visible - cost if wrong: a less specific console sentence.
- Ruling (D20): GET routes may write, because issuing a token is idempotent and happens once per newly claimed domain - cost if wrong: a read-only operator's GET writes the approvals file once.
- Ruling (D23): showing the TXT record value in both portals is intended: the verification token is public by design, and the anti-goal means credentials. The token never comes from a client and is never logged.

## Tasks

- Ruling (Task 4): with no approval store, verify answers the "not available on this control plane" sentence and the answer list is empty, since no tokens can exist - cost if wrong: one sentence.
- Ruling (Task 9): `MaxAnswerBytes` is 32 KiB, about four times the real worst case of roughly 8.3 KB (20 accepted domains with full answers) - cost if wrong: none.
- Ruling (Task 9): the console refuses a malformed domain with `InvalidEmailDomainError` (400), as the platform does, before the list lookup - one error vocabulary on every plane - cost if wrong: one branch.
- Ruling (Task 9): an advert answer without verifications clears the answers the console held; the platform's answer is the truth each cycle - cost if wrong: an older platform shows no records, and it cannot verify anyway.
- Ruling (Task 10): the platform portal captions that said "only once it is approved" were reworded to the G5 sentence - cost if wrong: copy change.
- Ruling (Tasks 10 and 11): the "no matching TXT record was found yet" notice also shows on an approved but unverified row; the sentence is true and the operator or Owner asked for the check - cost if wrong: one condition.

## Final review

- Ruling (throttle): the operator's verify (`PlatformEmailDomains.VerifyDomainAsOperator`) throttles under its own key, `operator:<tenantId>`, so a tenant that spams Verify cannot lock the platform operator out; the tenant plane and the console share the tenant's key - cost if wrong: the operator gets 10 more lookups per window per tenant.
- Ruling (M3): in the tenant portal, Verify keeps domain text the Owner has typed but not saved, and Save and Verify cannot run at the same time - cost if wrong: none.
- Ruling (M7): the console keeps a held answer whose `lastCheckedAt` is newer than an incoming advert answer for the same domain, so a slow advert cannot undo a fresh Verify - cost if wrong: none.
- Ruling (declined items): accepted as the reviewer judged. Policy-refused domains (public mail, public suffixes) cannot be claimed in the first place. The agent channel's short error labels are machine-facing. The token-reissue race needs a tenant id reused within 10 s - cost if wrong: none practical.

## Open evidence

- The DNS lookup runs against a fake resolver in every test; the first lookup against real DNS is the live run.
- Neither portal has a harness for rendered `.mu` templates, so the record line and the Verify button are covered by view-model tests only.

## Rule breaches (verified harmless)

- Task 4: a shell heredoc full-file write of `tenant-api/tenant-email-domains.ts` (bytes checked: ASCII, LF, as before).
- Task 5 fix round: a python replace script on the re-checker and its test (bytes checked: ASCII, LF).
- Tasks 5, 8 and 9 fix: some tests were written alongside the code and not run red first.
