// ReleasesModule - the Releases section as a ShellModule. One capability (rail
// entry) backed by ReleasesSectionService, which presents the section's pages in
// the shell's content region; its views merge in from ReleasesResources.

import ReleasesSectionService from "./releases-section-service.js"
import ReleasesResources from "./releases.resources.mu.js"

shell module ReleasesModule [ Name = "Releases" ] {
    .services: {
        ReleasesSectionService
    }

    Capability [ Name = "Releases", Icon = @ReleasesIcon, ServiceKey = ReleasesSectionService ]

    resources: {
        merge ReleasesResources
    }
}
