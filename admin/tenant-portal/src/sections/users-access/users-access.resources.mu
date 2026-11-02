// users-access.resources.mu - the Users & Access section's views. SKELETON (Task 5 fills it in).

import UsersAccessPageViewModel from "./users-access-page-view-model.js"

resources UsersAccessResources {
    DataTemplate [ DataType = UsersAccessPageViewModel ] {
        StackPanel [ Orientation = Vertical, Margin = (24,20,24,20) ] {
            TextBlock [ Text = "Users & Access", Style = @H3, Foreground = @Fg0 ]
        }
    }
}
