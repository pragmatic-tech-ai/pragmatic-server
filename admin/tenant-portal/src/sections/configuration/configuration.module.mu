// ConfigurationModule - the Configuration section as a ShellModule. One
// capability (rail entry) backed by ConfigurationSectionService, which
// presents the components list and a component's configuration page; their
// views merge in from ConfigurationResources.

import ConfigurationSectionService from "./configuration-section-service.js"
import ConfigurationResources from "./configuration.resources.mu.js"

shell module ConfigurationModule [ Name = "Configuration" ] {
    .services: {
        ConfigurationSectionService
    }

    Capability [ Name = "Configuration", Icon = @ConfigurationIcon, ServiceKey = ConfigurationSectionService ]

    resources: {
        merge ConfigurationResources
    }
}
