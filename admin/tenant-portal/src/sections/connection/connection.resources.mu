// connection.resources.mu - the Connection status section's view.
//
// ConnectionPageViewModel is presented full-width in the shell's content
// region, matched implicitly by type. Read-only: there is nothing here to
// manage. The environments list uses a keyed row template set as the
// ListBox's ItemTemplate (a ListBox resolves implicit-by-type templates only
// for MuralBase items, and the rows are Observables).

import ConnectionPageViewModel from "./connection-page-view-model.js"
import ConnectionEnvironmentRowViewModel from "./connection-page-view-model.js"

resources ConnectionResources {
    DataTemplate [ DataType = ConnectionPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Margin = (0,0,0,16) ] {
                TextBlock [ Text = "Connection status", Style = @H3, Foreground = @Fg0 ]
                TextBlock [ Text = "How your hive keeps in touch with Pragmatic. Informational: there is nothing here to manage.",
                            Style = @Body, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,4,0,0) ]
            }

            TextBlock [ DockPanel.Dock = Top, Text = "Checking the connection to Pragmatic...", Foreground = @Fg2,
                        Visibility = $IsLoading << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = "No hive yet. Your connection status appears once your hive is installed.",
                        Foreground = @Fg2, TextWrapping = Wrap, Visibility = $IsEmpty << ToVisibility ]
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsError << ToVisibility ] {
                TextBlock [ Text = "Could not load the connection status.", Foreground = @StateDangerInk ]
                TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap ]
            }
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsDenied << ToVisibility ] {
                TextBlock [ Text = "You don't have access to the connection status", Style = @UiLabel, Foreground = @Fg0 ]
                StackPanel [ Orientation = Horizontal, Margin = (0,4,0,0) ] {
                    TextBlock [ Text = "This needs access to your hive. Ask", Foreground = @Fg2, Margin = (0,0,4,0) ]
                    TextBlock [ Text = $OwnerContact, Foreground = @Fg1 ]
                }
            }

            ScrollViewer [ HorizontalScrollEnabled = false, Visibility = $IsPopulated << ToVisibility ] {
                StackPanel [ Orientation = Vertical ] {
                    // Home channel: the status and what it means.
                    TextBlock [ Text = "Home channel", Style = @TenantSectionCaption ]
                    Border [ Style = @TenantPanel ] {
                        StackPanel [ Orientation = Vertical ] {
                            StackPanel [ Orientation = Horizontal ] {
                                Border [ Fill = @StateSuccessSoft, Padding = (8,2,8,2), Margin = (0,0,8,0),
                                         Visibility = $IsConnected << ToVisibility ] {
                                    TextBlock [ Text = $StatusLabel, Style = @UiCaption, Foreground = @StateSuccessInk ]
                                }
                                Border [ Fill = @StateWarningSoft, Padding = (8,2,8,2), Margin = (0,0,8,0),
                                         Visibility = $IsQuiet << ToVisibility ] {
                                    TextBlock [ Text = $StatusLabel, Style = @UiCaption, Foreground = @StateWarningInk ]
                                }
                                TextBlock [ Text = $Headline, Foreground = @Fg0, VerticalAlignment = Center ]
                            }
                            Border [ Fill = @StateWarningSoft, Padding = (12,8,12,8), Margin = (0,12,0,0),
                                     Visibility = $IsQuiet << ToVisibility ] {
                                TextBlock [ Text = "Your environments keep running normally while the link is quiet. Nothing is lost; updates resume when the hive can reach Pragmatic again.",
                                            Foreground = @StateWarningInk, TextWrapping = Wrap ]
                            }
                        }
                    }

                    // How the connection works: outbound only.
                    TextBlock [ Text = "How the connection works", Style = @TenantSectionCaption ]
                    Border [ Style = @TenantPanel ] {
                        StackPanel [ Orientation = Vertical ] {
                            StackPanel [ Orientation = Horizontal, Margin = (0,0,0,8) ] {
                                StackPanel [ Orientation = Vertical, Margin = (0,0,16,0) ] {
                                    TextBlock [ Text = "Your hive", Style = @UiLabel, Foreground = @Fg0 ]
                                    TextBlock [ Text = $HiveLabel, Style = @Code, Foreground = @Fg2 ]
                                }
                                TextBlock [ Text = "outbound HTTPS  ->", Foreground = @Fg2, VerticalAlignment = Center, Margin = (0,0,16,0) ]
                                StackPanel [ Orientation = Vertical ] {
                                    TextBlock [ Text = "Pragmatic", Style = @UiLabel, Foreground = @Fg0 ]
                                }
                            }
                            TextBlock [ Text = "Pragmatic never initiates a connection into your hive. Your hive dials out; nothing connects in. Your data, users and secrets never leave the hive.",
                                        Foreground = @Fg2, TextWrapping = Wrap ]
                        }
                    }

                    // What runs in the hive, as its rollout probe reports it.
                    TextBlock [ Text = "What's running in your hive", Style = @TenantSectionCaption ]
                    Border [ Style = @TenantPanel ] {
                        StackPanel [ Orientation = Vertical ] {
                            TextBlock [ Text = $TargetVersionText, Foreground = @Fg1, Margin = (0,0,0,8) ]
                            TextBlock [ Text = $NoRowsText, Foreground = @Fg2, Visibility = $HasNoRows << ToVisibility ]
                            StackPanel [ Orientation = Vertical, Visibility = $HasRows << ToVisibility ] {
                                Grid [ Style = @TenantTableColumns ] {
                                    ColumnDefinitions {
                                        ColumnDefinition [ Width = GridLength.Star ]
                                        ColumnDefinition [ Width = GridLength.Star ]
                                        ColumnDefinition [ Width = GridLength.Star ]
                                    }
                                    TextBlock [ Grid.Column = 0, Text = "Environment", Style = @TenantTableHeader ]
                                    TextBlock [ Grid.Column = 1, Text = "Running image", Style = @TenantTableHeader ]
                                    TextBlock [ Grid.Column = 2, Text = "Health", Style = @TenantTableHeader ]
                                }
                                ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $Rows,
                                          ItemTemplate = @ConnectionEnvironmentRowTemplate ]
                            }
                        }
                    }
                }
            }
        }
    }

    DataTemplate x:key="ConnectionEnvironmentRowTemplate" [ DataType = ConnectionEnvironmentRowViewModel ] {
        Grid [ Style = @TenantTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            TextBlock [ Grid.Column = 0, Text = $Name, Style = @UiLabel, Foreground = @Fg0 ]
            TextBlock [ Grid.Column = 1, Text = $Image, Style = @Code, Foreground = @Fg1 ]
            TextBlock [ Grid.Column = 2, Text = $HealthLabel, Foreground = @Fg1 ]
        }
    }
}
