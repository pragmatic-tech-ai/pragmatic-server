// environments.resources.mu - the Environments section's views. SKELETON (Task 3 fills it in).

import EnvironmentsPageViewModel from "./environments-page-view-model.js"

resources EnvironmentsResources {
    DataTemplate [ DataType = EnvironmentsPageViewModel ] {
        StackPanel [ Orientation = Vertical, Margin = (24,20,24,20) ] {
            TextBlock [ Text = "Environments", Style = @H3, Foreground = @Fg0 ]
        }
    }
}
