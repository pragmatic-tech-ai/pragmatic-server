// ReleasePolicyModule - the Release Policy section as a ShellModule. One
// capability (rail entry) backed by ReleasePolicySectionService, which
// presents the policy rules, gated versions and adoption ledger in the
// shell's content region; the section's views merge in from
// ReleasePolicyResources.

import ReleasePolicySectionService from "./release-policy-section-service.js"
import ReleasePolicyResources from "./release-policy.resources.mu.js"

shell module ReleasePolicyModule [ Name = "Release Policy" ] {
    .services: {
        ReleasePolicySectionService
    }

    Capability [ Name = "Release Policy", Icon = @ReleasePolicyIcon, ServiceKey = ReleasePolicySectionService ]

    resources: {
        merge ReleasePolicyResources
    }
}
