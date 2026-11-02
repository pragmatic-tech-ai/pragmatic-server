// SettingsModule - the Settings section as a ShellModule. One capability (rail
// entry) backed by SettingsSectionService, which presents the section's pages in
// the shell's content region; its views merge in from SettingsResources.

import SettingsSectionService from "./settings-section-service.js"
import SettingsResources from "./settings.resources.mu.js"

shell module SettingsModule [ Name = "Settings" ] {
    .services: {
        SettingsSectionService
    }

    Capability [ Name = "Settings", Icon = @SettingsIcon, ServiceKey = SettingsSectionService ]

    resources: {
        merge SettingsResources
    }
}
