// fleet.resources.mu - the Fleet section's views.
//
// FleetPageViewModel is presented full-width in the shell's content region
// (ContentHostService.View); its template is matched implicitly by type.
// Needs-attention entries render through their implicit-by-type template;
// a hives-table row's name opens the hive in the Hives section. The section
// service itself backs the rail capability; the side pane stays hidden, so
// its template is empty.
//
// Table rows use keyed templates set as the ListBox's ItemTemplate: a ListBox
// resolves implicit-by-type templates only for MuralBase items, and the row
// view-models are Observables. Tables use the PortalTable ListBox template
// (shell resources) so rows span the table width.

import PortalSectionService from "../../shell/portal-section-service.js"
import FleetPageViewModel from "./fleet-page-view-model.js"
import FleetHiveRowViewModel from "./fleet-page-view-model.js"
import FleetAttentionItemViewModel from "./fleet-page-view-model.js"

resources FleetResources {
    // The hidden side pane still resolves a template for the active section
    // service (every section extends PortalSectionService); an empty one keeps
    // the "can not resolve template" diagnostic away.
    DataTemplate [ DataType = PortalSectionService ] {
        Border { }
    }

    DataTemplate [ DataType = FleetPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            // Page header.
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Margin = (0,0,0,16) ] {
                TextBlock [ Text = "Fleet", Style = @H3, Foreground = @Fg0 ]
                TextBlock [ Text = "Every hive, read from its last check-in. Exceptions first.",
                            Style = @Body, Foreground = @Fg2, Margin = (0,4,0,0) ]
            }

            // State presentation: loading, empty and error.
            TextBlock [ DockPanel.Dock = Top, Text = "Loading the fleet...", Foreground = @Fg2,
                        Visibility = $IsLoading << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = "No hives yet. Stand up a hive to see it here.",
                        Foreground = @Fg2, Visibility = $IsEmpty << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = $ErrorText, Foreground = @StateDangerInk,
                        TextWrapping = Wrap, Visibility = $IsError << ToVisibility ]

            // Populated: summary counts, Needs attention, then the hives table.
            DockPanel [ Visibility = $IsPopulated << ToVisibility ] {
                Grid [ DockPanel.Dock = Top, Margin = (0,0,0,16) ] {
                    RowDefinitions {
                        RowDefinition [ Height = GridLength.Auto ]
                    }
                    ColumnDefinitions {
                        ColumnDefinition [ Width = GridLength.Star ]
                        ColumnDefinition [ Width = GridLength.Star ]
                        ColumnDefinition [ Width = GridLength.Star ]
                        ColumnDefinition [ Width = GridLength.Star ]
                    }
                    Border [ Grid.Column = 0, Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,8,0) ] {
                        StackPanel [ Orientation = Vertical ] {
                            TextBlock [ Text = "Hives", Style = @UiCaption, Foreground = @Fg2 ]
                            TextBlock [ Text = $HiveCountText, Style = @H3, Foreground = @Fg0 ]
                        }
                    }
                    Border [ Grid.Column = 1, Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,8,0) ] {
                        StackPanel [ Orientation = Vertical ] {
                            TextBlock [ Text = "Need attention", Style = @UiCaption, Foreground = @Fg2 ]
                            TextBlock [ Text = $NeedAttentionCountText, Style = @H3, Foreground = @Fg0 ]
                        }
                    }
                    Border [ Grid.Column = 2, Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,8,0) ] {
                        StackPanel [ Orientation = Vertical ] {
                            TextBlock [ Text = "Not checking in", Style = @UiCaption, Foreground = @Fg2 ]
                            TextBlock [ Text = $NotCheckingInCountText, Style = @H3, Foreground = @Fg0 ]
                        }
                    }
                    Border [ Grid.Column = 3, Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10) ] {
                        StackPanel [ Orientation = Vertical ] {
                            TextBlock [ Text = "Environments observed", Style = @UiCaption, Foreground = @Fg2 ]
                            TextBlock [ Text = $EnvironmentsObservedText, Style = @H3, Foreground = @Fg0 ]
                        }
                    }
                }

                StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Margin = (0,0,0,16),
                             Visibility = $HasNeedsAttention << ToVisibility ] {
                    TextBlock [ Text = "Needs attention", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,0,6) ]
                    ListBox [ Style = @PortalTableList, HorizontalAlignment = Stretch, ItemsSource = $NeedsAttention, ItemTemplate = @FleetAttentionItemTemplate ]
                }

                TextBlock [ DockPanel.Dock = Top, Text = "Hives", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,0,6) ]
                // Portal tables don't scroll themselves; this one has no header row.
                ScrollViewer [ HorizontalScrollEnabled = false ] {
                    ListBox [ Style = @PortalTableList, HorizontalAlignment = Stretch, ItemsSource = $Rows, ItemTemplate = @FleetHiveRowTemplate ]
                }
            }
        }
    }

    // A Needs-attention entry: the hive, its owner and what is wrong.
    DataTemplate x:key="FleetAttentionItemTemplate" [ DataType = FleetAttentionItemViewModel ] {
        Border [ Fill = @StateWarningSoft, Padding = (10,6,10,6), Margin = (0,0,0,4) ] {
            StackPanel [ Orientation = Vertical ] {
                TextBlock [ Text = $DisplayName, Style = @UiLabel, Foreground = @Fg0 ]
                TextBlock [ Text = $OwnerLabel, Style = @UiCaption, Foreground = @Fg2 ]
                TextBlock [ Text = $IssuesText, Style = @UiCaption, Foreground = @StateWarningInk ]
            }
        }
    }

    // A hives-table row: name, owner, connection, last check-in, environments.
    // The name opens the hive's detail in the Hives section.
    DataTemplate x:key="FleetHiveRowTemplate" [ DataType = FleetHiveRowViewModel ] {
        Grid [ Style = @PortalTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            Button [ Grid.Column = 0, Variant = Ghost, Command = $OpenCommand, HorizontalAlignment = Left ] {
                TextBlock [ Text = $DisplayName, Style = @UiLabel ]
            }
            TextBlock [ Grid.Column = 1, Text = $OwnerLabel, Foreground = @Fg1, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 2, Text = $ConnectionLabel, Foreground = @Fg1, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 3, Text = $LastSeenLabel, Foreground = @Fg2, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 4, Text = $EnvironmentsLabel, Foreground = @Fg2, VerticalAlignment = Center ]
        }
    }
}
