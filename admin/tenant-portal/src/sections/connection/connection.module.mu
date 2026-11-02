// ConnectionModule - the Connection status section as a ShellModule. One
// capability (rail entry) backed by ConnectionSectionService, which presents
// the read-only Connection status page; its view merges in from
// ConnectionResources.

import ConnectionSectionService from "./connection-section-service.js"
import ConnectionResources from "./connection.resources.mu.js"

shell module ConnectionModule [ Name = "Connection status" ] {
    .services: {
        ConnectionSectionService
    }

    Capability [ Name = "Connection status", Icon = @ConnectionIcon, ServiceKey = ConnectionSectionService ]

    resources: {
        merge ConnectionResources
    }
}
