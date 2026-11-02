// overview.resources.mu - the Overview section's views.
//
// OverviewPageViewModel (home) and ActivityPageViewModel are presented
// full-width in the shell's content region, matched implicitly by type.
// ActivityRowTemplate is keyed (a ListBox resolves implicit-by-type templates
// only for MuralBase items) and shared by every activity list in the app.

import OverviewPageViewModel from "./overview-page-view-model.js"
import ActivityPageViewModel from "./activity-page-view-model.js"
import ActivityRowViewModel from "./activity-page-view-model.js"

resources OverviewResources {
    DataTemplate [ DataType = OverviewPageViewModel ] {
        StackPanel [ Orientation = Vertical, Margin = (24,20,24,20) ] {
            TextBlock [ Text = "Overview", Style = @H3, Foreground = @Fg0 ]
        }
    }

    DataTemplate x:key="ActivityRowTemplate" [ DataType = ActivityRowViewModel ] {
        DockPanel [ Margin = (8,4,8,4) ] {
            TextBlock [ DockPanel.Dock = Right, Text = $WhenLabel, Style = @UiCaption, Foreground = @Fg2, Margin = (12,0,0,0) ]
            TextBlock [ Text = $Summary, Foreground = @Fg1, TextWrapping = Wrap ]
        }
    }

    DataTemplate [ DataType = ActivityPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Margin = (0,0,0,16) ] {
                Button [ Variant = Ghost, Command = $BackCommand, HorizontalAlignment = Left, Margin = (0,0,0,8) ] {
                    TextBlock [ Text = "Back" ]
                }
                TextBlock [ Text = "Activity", Style = @H3, Foreground = @Fg0 ]
                TextBlock [ Text = "Changes to your environments observed while this page has been open. Newest first.",
                            Style = @Body, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,4,0,0) ]
            }
            TextBlock [ DockPanel.Dock = Top, Text = "No activity observed yet this session.", Foreground = @Fg2,
                        Visibility = $IsEmpty << ToVisibility ]
            ScrollViewer [ HorizontalScrollEnabled = false, Visibility = $IsPopulated << ToVisibility ] {
                ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $Rows,
                          ItemTemplate = @ActivityRowTemplate ]
            }
        }
    }
}
