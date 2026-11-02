// FleetModule - the Fleet section (home) as a ShellModule. One capability (rail
// entry) backed by FleetSectionService, which presents the Fleet page in the
// shell's content region; the section's views merge in from FleetResources.

import FleetSectionService from "./fleet-section-service.js"
import FleetResources from "./fleet.resources.mu.js"

shell module FleetModule [ Name = "Fleet" ] {
    .services: {
        FleetSectionService
    }

    Capability [ Name = "Fleet", ServiceKey = FleetSectionService ]

    resources: {
        merge FleetResources
    }
}
