// ClientsModule - the Clients section as a ShellModule. One capability (rail
// entry) backed by ClientsSectionService, which presents the clients list and
// a client's detail in the shell's content region; the section's views
// (pages, rows and the Create client dialog) merge in from ClientsResources.

import ClientsSectionService from "./clients-section-service.js"
import ClientsResources from "./clients.resources.mu.js"

shell module ClientsModule [ Name = "Clients" ] {
    .services: {
        ClientsSectionService
    }

    Capability [ Name = "Clients", Icon = @ClientsIcon, ServiceKey = ClientsSectionService ]

    resources: {
        merge ClientsResources
    }
}
