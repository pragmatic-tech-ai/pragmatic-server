// activity.resources.mu - the Activity section's views.
//
// ActivityPageViewModel (the audit log) and ActivityEntryPageViewModel are
// presented full-width in the shell's content region, matched implicitly by
// type. The audit log is read-only: no commands besides opening an entry.
//
// The table uses a keyed row template set as the ListBox's ItemTemplate (a
// ListBox resolves implicit templates only for MuralBase items) and the shared
// PortalTable ListBox template.

import ActivityPageViewModel from "./activity-page-view-model.js"
import ActivityRowViewModel from "./activity-page-view-model.js"
import ActivityEntryPageViewModel from "./activity-entry-page-view-model.js"

resources ActivityResources {
    DataTemplate [ DataType = ActivityPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Margin = (0,0,0,16) ] {
                TextBlock [ Text = "Activity", Style = @H3, Foreground = @Fg0 ]
                TextBlock [ Text = "Every change made in Platform Admin: who did it, when, and whether the control plane accepted it.",
                            Style = @Body, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,4,0,0) ]
            }

            TextBlock [ DockPanel.Dock = Top, Text = "Loading activity...", Foreground = @Fg2,
                        Visibility = $IsLoading << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = "No activity recorded yet. Changes made in Platform Admin appear here.",
                        Foreground = @Fg2, TextWrapping = Wrap, Visibility = $IsEmpty << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = $ErrorText, Foreground = @StateDangerInk,
                        TextWrapping = Wrap, Visibility = $IsError << ToVisibility ]

            // The page scrolls header and rows together, so both get the same
            // width whether or not a scroll bar shows.
            ScrollViewer [ HorizontalScrollEnabled = false, Visibility = $IsPopulated << ToVisibility ] {
                StackPanel [ Orientation = Vertical ] {
                    Grid [ Style = @PortalTableColumns ] {
                        RowDefinitions {
                            RowDefinition [ Height = GridLength.Auto ]
                        }
                        ColumnDefinitions {
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                        }
                        TextBlock [ Grid.Column = 0, Text = "When (UTC)", Style = @UiCaption, Foreground = @Fg2 ]
                        TextBlock [ Grid.Column = 1, Text = "Action", Style = @UiCaption, Foreground = @Fg2, Margin = (18,0,0,0) ]
                        TextBlock [ Grid.Column = 2, Text = "Operator", Style = @UiCaption, Foreground = @Fg2 ]
                        TextBlock [ Grid.Column = 3, Text = "Outcome", Style = @UiCaption, Foreground = @Fg2 ]
                    }
                    ListBox [ Style = @PortalTableList, HorizontalAlignment = Stretch, ItemsSource = $Rows, ItemTemplate = @ActivityRowTemplate ]
                }
            }
        }
    }

    // An audit-log row; the action opens the entry's detail.
    DataTemplate x:key="ActivityRowTemplate" [ DataType = ActivityRowViewModel ] {
        Grid [ Style = @PortalTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            TextBlock [ Grid.Column = 0, Text = $WhenLabel, Style = @Code, Foreground = @Fg2, VerticalAlignment = Center ]
            Button [ Grid.Column = 1, Variant = Ghost, Command = $OpenCommand, HorizontalAlignment = Left ] {
                TextBlock [ Text = $ActionLabel, Style = @UiLabel ]
            }
            TextBlock [ Grid.Column = 2, Text = $Actor, Foreground = @Fg1, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 3, Text = $OutcomeLabel, Foreground = @Fg1, VerticalAlignment = Center ]
        }
    }

    DataTemplate [ DataType = ActivityEntryPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Margin = (0,0,0,16) ] {
                Button [ Variant = Ghost, Command = $BackCommand, HorizontalAlignment = Left, Margin = (0,0,0,8) ] {
                    TextBlock [ Text = "Back" ]
                }
                TextBlock [ Text = $ActionLabel, Style = @H3, Foreground = @Fg0 ]
                TextBlock [ Text = $OutcomeLabel, Foreground = @Fg1, Margin = (0,4,0,0) ]
            }

            Border [ DockPanel.Dock = Top, Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10) ] {
                Grid {
                    RowDefinitions {
                        RowDefinition [ Height = GridLength.Auto ]
                        RowDefinition [ Height = GridLength.Auto ]
                    }
                    ColumnDefinitions {
                        ColumnDefinition [ Width = GridLength.Star ]
                        ColumnDefinition [ Width = GridLength.Star ]
                        ColumnDefinition [ Width = GridLength.Star ]
                    }
                    StackPanel [ Grid.Row = 0, Grid.Column = 0, Orientation = Vertical, Margin = (0,0,0,10) ] {
                        TextBlock [ Text = "Operator", Style = @UiCaption, Foreground = @Fg2 ]
                        TextBlock [ Text = $Actor, Foreground = @Fg0 ]
                    }
                    StackPanel [ Grid.Row = 0, Grid.Column = 1, Orientation = Vertical, Margin = (0,0,0,10) ] {
                        TextBlock [ Text = "When (UTC)", Style = @UiCaption, Foreground = @Fg2 ]
                        TextBlock [ Text = $WhenLabel, Style = @Code, Foreground = @Fg0 ]
                    }
                    StackPanel [ Grid.Row = 0, Grid.Column = 2, Orientation = Vertical, Margin = (0,0,0,10) ] {
                        TextBlock [ Text = "Response status", Style = @UiCaption, Foreground = @Fg2 ]
                        TextBlock [ Text = $StatusText, Style = @Code, Foreground = @Fg0 ]
                    }
                    StackPanel [ Grid.Row = 1, Grid.Column = 0, Orientation = Vertical ] {
                        TextBlock [ Text = "Method", Style = @UiCaption, Foreground = @Fg2 ]
                        TextBlock [ Text = $Method, Style = @Code, Foreground = @Fg0 ]
                    }
                    StackPanel [ Grid.Row = 1, Grid.Column = 1, Orientation = Vertical ] {
                        TextBlock [ Text = "Request", Style = @UiCaption, Foreground = @Fg2 ]
                        TextBlock [ Text = $Path, Style = @Code, Foreground = @Fg0, TextWrapping = Wrap ]
                    }
                }
            }
        }
    }
}
