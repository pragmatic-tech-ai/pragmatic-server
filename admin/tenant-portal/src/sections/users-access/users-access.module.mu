// UsersAccessModule - the Users & Access section as a ShellModule. One capability (rail
// entry) backed by UsersAccessSectionService, which presents the section's pages in
// the shell's content region; its views merge in from UsersAccessResources.

import UsersAccessSectionService from "./users-access-section-service.js"
import UsersAccessResources from "./users-access.resources.mu.js"

shell module UsersAccessModule [ Name = "Users & Access" ] {
    .services: {
        UsersAccessSectionService
    }

    Capability [ Name = "Users & Access", Icon = @UsersAccessIcon, ServiceKey = UsersAccessSectionService ]

    resources: {
        merge UsersAccessResources
    }
}
