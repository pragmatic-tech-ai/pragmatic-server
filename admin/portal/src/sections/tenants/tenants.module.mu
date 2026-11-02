// TenantsModule - the Tenants section as a ShellModule. One capability (rail
// entry) backed by TenantsSectionService, which presents the tenants list, a
// tenant's detail and the one-time Owner password reveal in the shell's
// content region; the section's views merge in from TenantsResources.

import TenantsSectionService from "./tenants-section-service.js"
import TenantsResources from "./tenants.resources.mu.js"

shell module TenantsModule [ Name = "Tenants" ] {
    .services: {
        TenantsSectionService
    }

    Capability [ Name = "Tenants", ServiceKey = TenantsSectionService ]

    resources: {
        merge TenantsResources
    }
}
