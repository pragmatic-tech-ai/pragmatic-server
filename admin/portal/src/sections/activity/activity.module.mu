// ActivityModule - the Activity section as a ShellModule. One capability
// (rail entry) backed by ActivitySectionService, which presents the audit log
// and an entry's detail in the shell's content region; the section's views
// merge in from ActivityResources.

import ActivitySectionService from "./activity-section-service.js"
import ActivityResources from "./activity.resources.mu.js"

shell module ActivityModule [ Name = "Activity" ] {
    .services: {
        ActivitySectionService
    }

    Capability [ Name = "Activity", Icon = @ActivityIcon, ServiceKey = ActivitySectionService ]

    resources: {
        merge ActivityResources
    }
}
