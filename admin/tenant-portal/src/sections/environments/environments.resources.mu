// environments.resources.mu - the Environments section's views.
//
// EnvironmentsPageViewModel (the list) and EnvironmentDetailPageViewModel are
// presented full-width in the shell's content region, matched implicitly by
// type. CreateEnvironmentDialogViewModel renders inside the shell's
// DialogService surface with its own Cancel / Create buttons. Stop and Delete
// use the shell's shared confirm dialogs.
//
// EnvironmentPillViewModel (a status or health pill) is matched implicitly
// through a ContentControl wherever a pill shows (this list, the detail
// header, the Overview's cards). Table rows use a keyed template set as the
// ListBox's ItemTemplate (a ListBox resolves implicit-by-type templates only
// for MuralBase items, and the rows are Observables). The detail's activity
// list reuses ActivityRowTemplate (overview resources). Tabs are a
// SegmentedButton over the page's TabLabels, each tab shown by its flag.

import EnvironmentsPageViewModel from "./environments-page-view-model.js"
import EnvironmentTableRowViewModel from "./environments-page-view-model.js"
import EnvironmentDetailPageViewModel from "./environment-detail-page-view-model.js"
import EnvironmentPillViewModel from "./environment-pill-view-model.js"
import CreateEnvironmentDialogViewModel from "./create-environment-dialog-view-model.js"

resources EnvironmentsResources {
    // A status or health pill, toned by what it says.
    DataTemplate [ DataType = EnvironmentPillViewModel ] {
        StackPanel [ Orientation = Horizontal ] {
            Border [ Fill = @StateSuccessSoft, Padding = (8,2,8,2), Visibility = $IsSuccess << ToVisibility ] {
                TextBlock [ Text = $Label, Style = @UiCaption, Foreground = @StateSuccessInk ]
            }
            Border [ Fill = @StateWarningSoft, Padding = (8,2,8,2), Visibility = $IsWarning << ToVisibility ] {
                TextBlock [ Text = $Label, Style = @UiCaption, Foreground = @StateWarningInk ]
            }
            Border [ Fill = @StateDangerSoft, Padding = (8,2,8,2), Visibility = $IsDanger << ToVisibility ] {
                TextBlock [ Text = $Label, Style = @UiCaption, Foreground = @StateDangerInk ]
            }
            Border [ Fill = @Bg2, Padding = (8,2,8,2), Visibility = $IsNeutral << ToVisibility ] {
                TextBlock [ Text = $Label, Style = @UiCaption, Foreground = @Fg1 ]
            }
        }
    }

    DataTemplate [ DataType = EnvironmentsPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            // Page header with its one primary action.
            DockPanel [ DockPanel.Dock = Top, Margin = (0,0,0,16) ] {
                Button [ DockPanel.Dock = Right, Variant = Primary, Command = $CreateCommand, VerticalAlignment = Top ] {
                    TextBlock [ Text = "Create environment" ]
                }
                StackPanel [ Orientation = Vertical ] {
                    TextBlock [ Text = "Environments", Style = @H3, Foreground = @Fg0 ]
                    TextBlock [ Text = "Running workspaces in your hive. Each serves Capability Maps at its own address.",
                                Style = @Body, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,4,0,0) ]
                    TextBlock [ Text = $DeniedReason, Style = @UiCaption, Foreground = @StateWarningInk, Margin = (0,4,0,0),
                                Visibility = $DeniedReason << ToVisibility ]
                    TextBlock [ Text = $CommandErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,4,0,0),
                                Visibility = $CommandErrorText << ToVisibility ]
                }
            }

            // States: loading, empty, error and denied.
            TextBlock [ DockPanel.Dock = Top, Text = "Loading environments...", Foreground = @Fg2,
                        Visibility = $IsLoading << ToVisibility ]
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsEmpty << ToVisibility ] {
                TextBlock [ Text = "No environments yet", Style = @UiLabel, Foreground = @Fg0 ]
                TextBlock [ Text = "Create your first environment to get a running workspace you can serve Capability Maps from.",
                            Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,4,0,12) ]
                Button [ Variant = Primary, Command = $CreateCommand, HorizontalAlignment = Left ] {
                    TextBlock [ Text = "Create environment" ]
                }
            }
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsError << ToVisibility ] {
                TextBlock [ Text = "Could not load your environments.", Foreground = @StateDangerInk ]
                TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap ]
            }
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsDenied << ToVisibility ] {
                TextBlock [ Text = "You don't have access to environments", Style = @UiLabel, Foreground = @Fg0 ]
                StackPanel [ Orientation = Horizontal, Margin = (0,4,0,0) ] {
                    TextBlock [ Text = "This needs an account in this tenant. Ask", Foreground = @Fg2, Margin = (0,0,4,0) ]
                    TextBlock [ Text = $OwnerContact, Foreground = @Fg1 ]
                }
            }

            // Populated: filter, bulk actions over the selection, the table.
            ScrollViewer [ HorizontalScrollEnabled = false, Visibility = $IsPopulated << ToVisibility ] {
                StackPanel [ Orientation = Vertical ] {
                    TextBox [ Text = $Filter, Placeholder = "Filter environments", HorizontalAlignment = Left, Margin = (0,0,0,12) ]
                    Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,6,12,6), Margin = (0,0,0,8),
                             Visibility = $HasSelection << ToVisibility ] {
                        StackPanel [ Orientation = Horizontal ] {
                            TextBlock [ Text = $SelectionText, Style = @UiLabel, Foreground = @Fg0, VerticalAlignment = Center, Margin = (0,0,12,0) ]
                            Button [ Variant = Secondary, Command = $StartCommand, Margin = (0,0,8,0) ] {
                                TextBlock [ Text = "Start" ]
                            }
                            Button [ Variant = Secondary, Command = $RestartCommand, Margin = (0,0,8,0) ] {
                                TextBlock [ Text = "Restart" ]
                            }
                            Button [ Variant = Secondary, Command = $StopCommand, Margin = (0,0,12,0) ] {
                                TextBlock [ Text = "Stop" ]
                            }
                            TextBlock [ Text = "Deleting is one environment at a time.", Style = @UiCaption, Foreground = @Fg2,
                                        VerticalAlignment = Center ]
                        }
                    }
                    Grid [ Style = @TenantTableColumns ] {
                        ColumnDefinitions {
                            ColumnDefinition [ Width = GridLength.Auto ]
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                        }
                        Checkbox [ Grid.Column = 0, IsChecked = $AllSelected, VerticalAlignment = Center, Margin = (0,0,8,0) ]
                        TextBlock [ Grid.Column = 1, Text = "Environment", Style = @TenantTableLinkHeader, VerticalAlignment = Center ]
                        TextBlock [ Grid.Column = 2, Text = "Status", Style = @TenantTableHeader, VerticalAlignment = Center ]
                        TextBlock [ Grid.Column = 3, Text = "Version", Style = @TenantTableHeader, VerticalAlignment = Center ]
                        TextBlock [ Grid.Column = 4, Text = "Health", Style = @TenantTableHeader, VerticalAlignment = Center ]
                        TextBlock [ Grid.Column = 5, Text = "Live URL", Style = @TenantTableHeader, VerticalAlignment = Center ]
                    }
                    TextBlock [ Text = "No environments match the filter.", Foreground = @Fg2, Margin = (8,8,8,8),
                                Visibility = $HasNoMatches << ToVisibility ]
                    ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $Rows,
                              ItemTemplate = @EnvironmentTableRowTemplate ]
                }
            }
        }
    }

    // An environments-table row; the name opens the environment's detail.
    DataTemplate x:key="EnvironmentTableRowTemplate" [ DataType = EnvironmentTableRowViewModel ] {
        Grid [ Style = @TenantTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Auto ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            Checkbox [ Grid.Column = 0, IsChecked = $IsSelected, VerticalAlignment = Center, Margin = (0,0,8,0) ]
            StackPanel [ Grid.Column = 1, Orientation = Vertical, VerticalAlignment = Center ] {
                Button [ Variant = Ghost, Command = $OpenCommand, HorizontalAlignment = Left ] {
                    TextBlock [ Text = $Name, Style = @UiLabel ]
                }
                TextBlock [ Text = $SubText, Style = @Code, Foreground = @Fg2, Margin = (18,0,0,0) ]
            }
            ContentControl [ Grid.Column = 2, Content = $StatusPill, HorizontalAlignment = Left, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 3, Text = $Version, Style = @Code, Foreground = @Fg1, VerticalAlignment = Center ]
            ContentControl [ Grid.Column = 4, Content = $HealthPill, HorizontalAlignment = Left, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 5, Text = $UrlText, Style = @Code, Foreground = @Fg1, VerticalAlignment = Center,
                        Visibility = $IsServing << ToVisibility ]
            TextBlock [ Grid.Column = 5, Text = $UrlText, Style = @UiCaption, Foreground = @Fg2, VerticalAlignment = Center,
                        Visibility = $IsNotServing << ToVisibility ]
        }
    }

    DataTemplate [ DataType = EnvironmentDetailPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            // Page header: back, the environment, its lifecycle and Delete.
            DockPanel [ DockPanel.Dock = Top, Margin = (0,0,0,12) ] {
                StackPanel [ DockPanel.Dock = Right, Orientation = Horizontal, VerticalAlignment = Top ] {
                    Button [ Variant = Secondary, Command = $StartCommand, Margin = (0,0,8,0), Visibility = $IsStopped << ToVisibility ] {
                        TextBlock [ Text = "Start" ]
                    }
                    Button [ Variant = Secondary, Command = $StopCommand, Margin = (0,0,8,0), Visibility = $IsRunning << ToVisibility ] {
                        TextBlock [ Text = "Stop" ]
                    }
                    Button [ Variant = Secondary, Command = $RestartCommand, Margin = (0,0,8,0), Visibility = $IsRunning << ToVisibility ] {
                        TextBlock [ Text = "Restart" ]
                    }
                    Button [ Variant = Danger, Command = $DeleteCommand ] {
                        TextBlock [ Text = "Delete" ]
                    }
                }
                StackPanel [ Orientation = Vertical ] {
                    Button [ Variant = Ghost, Command = $BackCommand, HorizontalAlignment = Left, Margin = (0,0,0,8) ] {
                        TextBlock [ Text = "Back" ]
                    }
                    StackPanel [ Orientation = Horizontal ] {
                        TextBlock [ Text = $Name, Style = @H3, Foreground = @Fg0, VerticalAlignment = Center, Margin = (0,0,12,0) ]
                        ContentControl [ Content = $StatusPill, VerticalAlignment = Center, Margin = (0,0,8,0) ]
                        ContentControl [ Content = $HealthPill, VerticalAlignment = Center ]
                    }
                    TextBlock [ Text = $SubText, Style = @Code, Foreground = @Fg2, Margin = (0,4,0,0) ]
                    TextBlock [ Text = $UrlText, Style = @Code, Foreground = @Fg1, Margin = (0,4,0,0) ]
                    TextBlock [ Text = $DeniedReason, Style = @UiCaption, Foreground = @StateWarningInk, Margin = (0,4,0,0),
                                Visibility = $DeniedReason << ToVisibility ]
                    TextBlock [ Text = $CommandErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,4,0,0),
                                Visibility = $CommandErrorText << ToVisibility ]
                }
            }

            TextBlock [ DockPanel.Dock = Top, Text = "Loading the environment...", Foreground = @Fg2,
                        Visibility = $IsLoading << ToVisibility ]
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsError << ToVisibility ] {
                TextBlock [ Text = "Could not load this environment.", Foreground = @StateDangerInk ]
                TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap ]
            }
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsDenied << ToVisibility ] {
                TextBlock [ Text = "You don't have access to this environment", Style = @UiLabel, Foreground = @Fg0 ]
                StackPanel [ Orientation = Horizontal, Margin = (0,4,0,0) ] {
                    TextBlock [ Text = "This needs an account in this tenant. Ask", Foreground = @Fg2, Margin = (0,0,4,0) ]
                    TextBlock [ Text = $OwnerContact, Foreground = @Fg1 ]
                }
            }

            ScrollViewer [ HorizontalScrollEnabled = false, Visibility = $IsPopulated << ToVisibility ] {
                StackPanel [ Orientation = Vertical ] {
                    // What a failed or unknown state means.
                    Border [ Fill = @StateDangerSoft, Padding = (12,8,12,8), Margin = (0,0,0,12),
                             Visibility = $IsFailed << ToVisibility ] {
                        TextBlock [ Text = "This environment failed to start.", Foreground = @StateDangerInk, TextWrapping = Wrap ]
                    }
                    Border [ Fill = @StateInfoSoft, Padding = (12,8,12,8), Margin = (0,0,0,12),
                             Visibility = $IsUnknown << ToVisibility ] {
                        TextBlock [ Text = "The state of this environment is unknown.", Foreground = @Fg1, TextWrapping = Wrap ]
                    }

                    SegmentedButton [ Items = $TabLabels, SelectedItem = $SelectedTab, SelectionMode = Single,
                                      HorizontalAlignment = Left, Margin = (0,0,0,16) ]

                    // Application & version.
                    StackPanel [ Orientation = Vertical, Visibility = $IsApplicationTab << ToVisibility ] {
                        TextBlock [ Text = "Deployed now", Style = @TenantSectionCaption ]
                        Border [ Style = @TenantPanel ] {
                            Grid {
                                ColumnDefinitions {
                                    ColumnDefinition [ Width = GridLength.Auto ]
                                    ColumnDefinition [ Width = GridLength.Star ]
                                }
                                RowDefinitions {
                                    RowDefinition [ Height = GridLength.Auto ]
                                    RowDefinition [ Height = GridLength.Auto ]
                                    RowDefinition [ Height = GridLength.Auto ]
                                    RowDefinition [ Height = GridLength.Auto ]
                                    RowDefinition [ Height = GridLength.Auto ]
                                    RowDefinition [ Height = GridLength.Auto ]
                                    RowDefinition [ Height = GridLength.Auto ]
                                }
                                TextBlock [ Grid.Row = 0, Grid.Column = 0, Text = "Version", Style = @TenantKey, Margin = (0,0,16,6) ]
                                TextBlock [ Grid.Row = 0, Grid.Column = 1, Text = $Version, Style = @Code, Foreground = @Fg0 ]
                                TextBlock [ Grid.Row = 1, Grid.Column = 0, Text = "Type", Style = @TenantKey, Margin = (0,0,16,6) ]
                                TextBlock [ Grid.Row = 1, Grid.Column = 1, Text = $Type, Foreground = @Fg0 ]
                                TextBlock [ Grid.Row = 2, Grid.Column = 0, Text = "Template", Style = @TenantKey, Margin = (0,0,16,6) ]
                                TextBlock [ Grid.Row = 2, Grid.Column = 1, Text = $Template, Foreground = @Fg0 ]
                                TextBlock [ Grid.Row = 3, Grid.Column = 0, Text = "Environment id", Style = @TenantKey, Margin = (0,0,16,6) ]
                                TextBlock [ Grid.Row = 3, Grid.Column = 1, Text = $EnvironmentId, Style = @Code, Foreground = @Fg0 ]
                                TextBlock [ Grid.Row = 4, Grid.Column = 0, Text = "Created", Style = @TenantKey, Margin = (0,0,16,6) ]
                                TextBlock [ Grid.Row = 4, Grid.Column = 1, Text = $Created, Foreground = @Fg0 ]
                                TextBlock [ Grid.Row = 5, Grid.Column = 0, Text = "UI bundle", Style = @TenantKey, Margin = (0,0,16,6) ]
                                TextBlock [ Grid.Row = 5, Grid.Column = 1, Text = $UiBundleText, Foreground = @Fg0 ]
                                TextBlock [ Grid.Row = 6, Grid.Column = 0, Text = "Image signature", Style = @TenantKey, Margin = (0,0,16,0) ]
                                TextBlock [ Grid.Row = 6, Grid.Column = 1, Text = $SignatureText, Foreground = @Fg0 ]
                            }
                        }
                        TextBlock [ Text = "Newer version offered", Style = @TenantSectionCaption, Visibility = $HasOffer << ToVisibility ]
                        Border [ Style = @TenantPanel, Visibility = $HasOffer << ToVisibility ] {
                            StackPanel [ Orientation = Vertical ] {
                                TextBlock [ Text = $OfferTitle, Style = @UiLabel, Foreground = @Fg0 ]
                                TextBlock [ Text = "Offered by Pragmatic. You choose if and when to adopt.", Foreground = @Fg2, Margin = (0,4,0,0) ]
                                TextBlock [ Text = $OfferNotes, Foreground = @Fg1, TextWrapping = Wrap, Margin = (0,8,0,0),
                                            Visibility = $OfferNotes << ToVisibility ]
                                Button [ Variant = Primary, Command = $ReviewAdoptCommand, HorizontalAlignment = Left, Margin = (0,12,0,0) ] {
                                    TextBlock [ Text = "Review and adopt" ]
                                }
                                TextBlock [ Text = $AdoptDeniedReason, Style = @UiCaption, Foreground = @StateWarningInk, Margin = (0,4,0,0),
                                            Visibility = $AdoptDeniedReason << ToVisibility ]
                            }
                        }
                        TextBlock [ Text = "Version offers", Style = @TenantSectionCaption, Visibility = $HasNoOffer << ToVisibility ]
                        Border [ Style = @TenantPanel, Visibility = $HasNoOffer << ToVisibility ] {
                            TextBlock [ Text = $NewestText, Foreground = @Fg2 ]
                        }
                    }

                    // Health & activity.
                    StackPanel [ Orientation = Vertical, Visibility = $IsHealthTab << ToVisibility ] {
                        TextBlock [ Text = "Right now", Style = @TenantSectionCaption ]
                        Border [ Style = @TenantPanel ] {
                            TextBlock [ Text = $HealthText, Foreground = @Fg1 ]
                        }
                        TextBlock [ Text = "Recent activity", Style = @TenantSectionCaption ]
                        Border [ Style = @TenantPanel ] {
                            StackPanel [ Orientation = Vertical ] {
                                TextBlock [ Text = "No activity observed for this environment yet this session.", Foreground = @Fg2,
                                            Visibility = $HasNoActivity << ToVisibility ]
                                ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $ActivityRows,
                                          ItemTemplate = @ActivityRowTemplate, Visibility = $HasActivity << ToVisibility ]
                            }
                        }
                        StackPanel [ Orientation = Horizontal, Margin = (0,0,0,8) ] {
                            Button [ Variant = Secondary, Command = $ToggleLogsCommand, Margin = (0,0,8,0) ] {
                                TextBlock [ Text = $LogsToggleLabel ]
                            }
                            Button [ Variant = Secondary, Command = $TogglePauseCommand, Visibility = $LogsOpen << ToVisibility ] {
                                TextBlock [ Text = $PauseLabel ]
                            }
                        }
                        Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,0,16),
                                 Visibility = $LogsOpen << ToVisibility ] {
                            ScrollViewer [ HorizontalScrollEnabled = false, MaxHeight = 360 ] {
                                TextBlock [ Text = $LogText, Style = @Code, Foreground = @Fg1, TextWrapping = Wrap ]
                            }
                        }
                    }

                    // Access.
                    StackPanel [ Orientation = Vertical, Visibility = $IsAccessTab << ToVisibility ] {
                        TextBlock [ Text = "Addresses", Style = @TenantSectionCaption ]
                        Border [ Style = @TenantPanel ] {
                            Grid {
                                ColumnDefinitions {
                                    ColumnDefinition [ Width = GridLength.Auto ]
                                    ColumnDefinition [ Width = GridLength.Star ]
                                }
                                RowDefinitions {
                                    RowDefinition [ Height = GridLength.Auto ]
                                    RowDefinition [ Height = GridLength.Auto ]
                                }
                                TextBlock [ Grid.Row = 0, Grid.Column = 0, Text = "Address", Style = @TenantKey, Margin = (0,0,16,6) ]
                                TextBlock [ Grid.Row = 0, Grid.Column = 1, Text = $UrlText, Style = @Code, Foreground = @Fg0 ]
                                TextBlock [ Grid.Row = 1, Grid.Column = 0, Text = "Sign-in address", Style = @TenantKey, Margin = (0,0,16,0) ]
                                TextBlock [ Grid.Row = 1, Grid.Column = 1, Text = $SignInAddress, Style = @Code, Foreground = @Fg0 ]
                            }
                        }
                    }
                }
            }
        }
    }

    // Create environment.
    DataTemplate [ DataType = CreateEnvironmentDialogViewModel ] {
        StackPanel [ Orientation = Vertical, Margin = (0,4,0,0) ] {
            TextBlock [ Text = "Runs in your hive. It takes a few minutes; you can leave this page.",
                        TextWrapping = Wrap, Foreground = @Fg2, Margin = (0,0,0,12) ]
            TextBlock [ Text = "Name", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ Text = $Name, Placeholder = "e.g. training-q4", Margin = (0,0,0,4) ]
            TextBlock [ Text = "Lowercase letters, digits and hyphens.", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBlock [ Text = $NameErrorText, Style = @UiCaption, Foreground = @StateDangerInk, Margin = (0,0,0,4),
                        Visibility = $NameErrorText << ToVisibility ]
            TextBlock [ Text = "Template", Style = @UiCaption, Foreground = @Fg2, Margin = (0,8,0,4) ]
            ComboBox [ ItemsSource = $Templates, SelectedItem = $SelectedTemplate, HorizontalAlignment = Stretch, Margin = (0,0,0,12) ]
            TextBlock [ Text = "Type", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            ComboBox [ ItemsSource = $Types, SelectedItem = $SelectedType, HorizontalAlignment = Stretch, Margin = (0,0,0,12) ]
            TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,0,0,12),
                        Visibility = $ErrorText << ToVisibility ]
            StackPanel [ Orientation = Horizontal, HorizontalAlignment = Right ] {
                Button [ Variant = Secondary, Command = $CancelCommand, Margin = (0,0,8,0) ] {
                    TextBlock [ Text = "Cancel" ]
                }
                Button [ Variant = Primary, Command = $ConfirmCommand ] {
                    TextBlock [ Text = "Create environment" ]
                }
            }
        }
    }
}
