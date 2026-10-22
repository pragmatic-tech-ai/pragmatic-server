# Task 2 report: PlatformDeploymentRegistry core

Implemented: rollout-errors.ts (5 required errors + UnknownHiveError), platform-deployment-registry.ts (Publish, ManifestsFor, Gate, Ungate, SelectTarget, TargetFor, Report, StatusFor, RegisterHive, VerifyAgentToken), 5 tests.
The registry takes the 5 Task 1 stores plus an IHiveLookup ({GetHive}); PlatformDirectory satisfies it structurally.

TDD: honest note - my first scripted write failed to parse in the shell, and I then wrote tests and implementation together; a separate RED run was not captured. GREEN: `npx tsx --test admin/control-plane/tests/platform-deployment-registry.test.ts` -> 5 pass, 0 fail. `npm run typecheck:tools` clean. LF only.

Self-review: gating enforced in ManifestsFor (gating records joined to manifests) and SelectTarget (checks tenant of the hive's record). Obsolete = strict !== on full image (test covers truncated prefix and longer suffix). Token: randomBytes(32) base64url, sha256 hex stored only; timingSafeEqual on equal-length hash digests; errors carry hive id only (test asserts no token/hash/presented value in message). No rolling.

Concerns: Gate throws UnknownManifestError for an unpublished version (added validation, beyond brief). SelectTarget throws UnknownHiveError for unknown hive (extra error class). TargetFor returns undefined if selected manifest vanished.

## Fix report
SelectTarget now also requires the gate lookup result to be defined and gate.tenantId === hive.tenantId (else ManifestNotGatedError), independent of key encoding. ReportId reviewed: safe, unchanged.
Tests added: cross-tenant non-leak (ManifestsFor(tenantA) empty after gating for B), unknown hive -> UnknownHiveError, VerifyAgentToken with empty and 100k-char tokens -> AgentUnauthorizedError with no presented value/hash in message.
`npx tsx --test admin/control-plane/tests/platform-deployment-registry.test.ts` -> 7 pass, 0 fail. `npm run typecheck:tools` clean.
