// security-model.resources.mu - the Roles & permissions tab (security-model
// editor). SKELETON (Task 6 fills it in). Merged by UsersAccessModule.

import SecurityModelEditorViewModel from "./security-model-editor-view-model.js"

resources SecurityModelResources {
    DataTemplate [ DataType = SecurityModelEditorViewModel ] {
        StackPanel [ Orientation = Vertical ] {
            TextBlock [ Text = "Roles & permissions", Style = @UiLabel, Foreground = @Fg0 ]
        }
    }
}
