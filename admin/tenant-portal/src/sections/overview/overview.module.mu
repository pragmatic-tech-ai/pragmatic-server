// OverviewModule - the Overview section (home) as a ShellModule. One
// capability (rail entry) backed by OverviewSectionService, which presents the
// Overview page and the session's Activity page in the shell's content region;
// the section's views merge in from OverviewResources.

import OverviewSectionService from "./overview-section-service.js"
import OverviewResources from "./overview.resources.mu.js"

shell module OverviewModule [ Name = "Overview" ] {
    .services: {
        OverviewSectionService
    }

    Capability [ Name = "Overview", Icon = @OverviewIcon, ServiceKey = OverviewSectionService ]

    resources: {
        merge OverviewResources
    }
}
