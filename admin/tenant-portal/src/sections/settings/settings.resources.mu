// settings.resources.mu - the Settings section's views. SKELETON (Task 4 fills it in).

import SettingsPageViewModel from "./settings-page-view-model.js"

resources SettingsResources {
    DataTemplate [ DataType = SettingsPageViewModel ] {
        StackPanel [ Orientation = Vertical, Margin = (24,20,24,20) ] {
            TextBlock [ Text = "Settings", Style = @H3, Foreground = @Fg0 ]
        }
    }
}
