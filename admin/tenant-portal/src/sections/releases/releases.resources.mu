// releases.resources.mu - the Releases section's views. SKELETON (Task 4 fills it in).

import ReleasesPageViewModel from "./releases-page-view-model.js"

resources ReleasesResources {
    DataTemplate [ DataType = ReleasesPageViewModel ] {
        StackPanel [ Orientation = Vertical, Margin = (24,20,24,20) ] {
            TextBlock [ Text = "Releases", Style = @H3, Foreground = @Fg0 ]
        }
    }
}
