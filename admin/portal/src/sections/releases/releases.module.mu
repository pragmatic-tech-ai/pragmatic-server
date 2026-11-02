// ReleasesModule - the Registry & Releases section as a ShellModule. One
// capability (rail entry) backed by ReleasesSectionService, which presents the
// published versions and a version's detail in the shell's content region;
// the section's views merge in from ReleasesResources.

import ReleasesSectionService from "./releases-section-service.js"
import ReleasesResources from "./releases.resources.mu.js"

shell module ReleasesModule [ Name = "Registry & Releases" ] {
    .services: {
        ReleasesSectionService
    }

    Capability [ Name = "Registry & Releases", Icon = @ReleasesIcon, ServiceKey = ReleasesSectionService ]

    resources: {
        merge ReleasesResources
    }
}
