// HivesModule - the Hives section as a ShellModule. One capability (rail
// entry) backed by HivesSectionService, which presents the hives list and a
// hive's detail in the shell's content region (Fleet and a tenant's hive
// binding open a hive here too); the section's views merge in from
// HivesResources.

import HivesSectionService from "./hives-section-service.js"
import HivesResources from "./hives.resources.mu.js"

shell module HivesModule [ Name = "Hives" ] {
    .services: {
        HivesSectionService
    }

    Capability [ Name = "Hives", Icon = @HivesIcon, ServiceKey = HivesSectionService ]

    resources: {
        merge HivesResources
    }
}
