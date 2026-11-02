// EnvironmentsModule - the Environments section as a ShellModule. One capability (rail
// entry) backed by EnvironmentsSectionService, which presents the section's pages in
// the shell's content region; its views merge in from EnvironmentsResources.

import EnvironmentsSectionService from "./environments-section-service.js"
import EnvironmentsResources from "./environments.resources.mu.js"

shell module EnvironmentsModule [ Name = "Environments" ] {
    .services: {
        EnvironmentsSectionService
    }

    Capability [ Name = "Environments", Icon = @EnvironmentsIcon, ServiceKey = EnvironmentsSectionService ]

    resources: {
        merge EnvironmentsResources
    }
}
