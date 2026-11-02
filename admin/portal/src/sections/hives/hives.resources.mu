// hives.resources.mu - the Hives section's views.
//
// HivesPageViewModel (the list) and HiveDetailPageViewModel are presented
// full-width in the shell's content region, matched implicitly by type.
// Credentials appear by reference name and status only; no secret value is on
// any hive view. NewHiveDialogViewModel renders inside the shell's
// DialogService surface with its own Cancel / Create buttons. The
// observed environments render through the shared, read-only
// ObservedEnvironmentsViewModel template (shell resources).
//
// Table rows use keyed templates set as the ListBox's ItemTemplate: a ListBox
// resolves implicit-by-type templates only for MuralBase items, and the row
// view-models are Observables. Tables use the PortalTable ListBox template
// (shell resources) so rows span the table width.

import HivesPageViewModel from "./hives-page-view-model.js"
import HiveRowViewModel from "./hives-page-view-model.js"
import HiveDetailPageViewModel from "./hive-detail-page-view-model.js"
import HiveCredentialViewModel from "./hive-detail-page-view-model.js"
import HiveRolloutRowViewModel from "./hive-detail-page-view-model.js"
import HiveLedgerRowViewModel from "./hive-detail-page-view-model.js"
import HiveCheckInRowViewModel from "./hive-detail-page-view-model.js"
import NewHiveDialogViewModel from "./new-hive-dialog-view-model.js"

resources HivesResources {
    DataTemplate [ DataType = HivesPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            // Page header: Stand up a hive is the primary action (enabled
            // with the provision wizard); Create hive registers a record.
            DockPanel [ DockPanel.Dock = Top, Margin = (0,0,0,16) ] {
                Button [ DockPanel.Dock = Right, Variant = Primary, Command = $StandUpCommand, VerticalAlignment = Top ] {
                    TextBlock [ Text = "Stand up a hive" ]
                }
                Button [ DockPanel.Dock = Right, Variant = Secondary, Command = $NewCommand, VerticalAlignment = Top, Margin = (0,0,8,0) ] {
                    TextBlock [ Text = "Create hive" ]
                }
                StackPanel [ Orientation = Vertical ] {
                    TextBlock [ Text = "Hives", Style = @H3, Foreground = @Fg0 ]
                    TextBlock [ Text = "Pragmatic deployments running in client infrastructure. Hives dial home; Pragmatic never connects in.",
                                Style = @Body, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,4,0,0) ]
                    TextBlock [ Text = $DeniedReason, Style = @UiCaption, Foreground = @StateWarningInk, Margin = (0,4,0,0),
                                Visibility = $DeniedReason << ToVisibility ]
                    TextBlock [ Text = $CommandErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,4,0,0),
                                Visibility = $CommandErrorText << ToVisibility ]
                }
            }

            // State presentation: loading, empty and error.
            TextBlock [ DockPanel.Dock = Top, Text = "Loading hives...", Foreground = @Fg2,
                        Visibility = $IsLoading << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = "No hives yet. Stand up a hive to generate the one-time bootstrap a client applies in their cluster.",
                        Foreground = @Fg2, TextWrapping = Wrap, Visibility = $IsEmpty << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = $ErrorText, Foreground = @StateDangerInk,
                        TextWrapping = Wrap, Visibility = $IsError << ToVisibility ]

            // Populated: the hives table.
            DockPanel [ Visibility = $IsPopulated << ToVisibility ] {
                Grid [ DockPanel.Dock = Top, Margin = (8,0,8,6) ] {
                    RowDefinitions {
                        RowDefinition [ Height = GridLength.Auto ]
                    }
                    ColumnDefinitions {
                        ColumnDefinition [ Width = GridLength.Star ]
                        ColumnDefinition [ Width = GridLength.Star ]
                        ColumnDefinition [ Width = GridLength.Star ]
                        ColumnDefinition [ Width = GridLength.Star ]
                        ColumnDefinition [ Width = GridLength.Star ]
                        ColumnDefinition [ Width = GridLength.Star ]
                    }
                    TextBlock [ Grid.Column = 0, Text = "Hive", Style = @UiCaption, Foreground = @Fg2 ]
                    TextBlock [ Grid.Column = 1, Text = "Client / tenant", Style = @UiCaption, Foreground = @Fg2 ]
                    TextBlock [ Grid.Column = 2, Text = "Cluster", Style = @UiCaption, Foreground = @Fg2 ]
                    TextBlock [ Grid.Column = 3, Text = "Connection", Style = @UiCaption, Foreground = @Fg2 ]
                    TextBlock [ Grid.Column = 4, Text = "Health", Style = @UiCaption, Foreground = @Fg2 ]
                    TextBlock [ Grid.Column = 5, Text = "Registry credential", Style = @UiCaption, Foreground = @Fg2 ]
                }
                ListBox [ Template = @PortalTable, HorizontalAlignment = Stretch, ItemsSource = $Rows, ItemTemplate = @HiveRowTemplate ]
            }
        }
    }

    // A hives-table row; the name opens the hive's detail.
    DataTemplate x:key="HiveRowTemplate" [ DataType = HiveRowViewModel ] {
        Grid [ Margin = (4,2,4,2) ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
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
            TextBlock [ Grid.Column = 2, Text = $ClusterLabel, Foreground = @Fg1, VerticalAlignment = Center ]
            StackPanel [ Grid.Column = 3, Orientation = Vertical, VerticalAlignment = Center ] {
                TextBlock [ Text = $ConnectionLabel, Foreground = @Fg1 ]
                TextBlock [ Text = $LastSeenLabel, Style = @UiCaption, Foreground = @Fg2 ]
            }
            TextBlock [ Grid.Column = 4, Text = $HealthLabel, Foreground = @Fg1, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 5, Text = $CredentialLabel, Style = @Code, Foreground = @Fg2, VerticalAlignment = Center ]
        }
    }

    DataTemplate [ DataType = HiveDetailPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            // Page header: back, the hive, and Delete.
            DockPanel [ DockPanel.Dock = Top, Margin = (0,0,0,16) ] {
                Button [ DockPanel.Dock = Right, Variant = Danger, Command = $DeleteCommand, VerticalAlignment = Top ] {
                    TextBlock [ Text = "Delete hive" ]
                }
                StackPanel [ Orientation = Vertical ] {
                    Button [ Variant = Ghost, Command = $BackCommand, HorizontalAlignment = Left, Margin = (0,0,0,8) ] {
                        TextBlock [ Text = "Back" ]
                    }
                    TextBlock [ Text = $DisplayName, Style = @H3, Foreground = @Fg0 ]
                    StackPanel [ Orientation = Horizontal, Margin = (0,4,0,0) ] {
                        TextBlock [ Text = $Id, Style = @Code, Foreground = @Fg2, Margin = (0,0,12,0) ]
                        TextBlock [ Text = $OwnerLabel, Foreground = @Fg1, Margin = (0,0,12,0) ]
                        TextBlock [ Text = $ClusterLabel, Foreground = @Fg2 ]
                    }
                    TextBlock [ Text = $DeniedReason, Style = @UiCaption, Foreground = @StateWarningInk, Margin = (0,4,0,0),
                                Visibility = $DeniedReason << ToVisibility ]
                    TextBlock [ Text = $CommandErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,4,0,0),
                                Visibility = $CommandErrorText << ToVisibility ]
                }
            }

            TextBlock [ DockPanel.Dock = Top, Text = "Loading the hive...", Foreground = @Fg2,
                        Visibility = $IsLoading << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = $ErrorText, Foreground = @StateDangerInk,
                        TextWrapping = Wrap, Visibility = $IsError << ToVisibility ]

            ScrollViewer [ HorizontalScrollEnabled = false, Visibility = $IsPopulated << ToVisibility ] {
                StackPanel [ Orientation = Vertical ] {
                    Border [ Fill = @StateWarningSoft, Padding = (12,10,12,10), Margin = (0,0,0,16),
                             Visibility = $HasBanner << ToVisibility ] {
                        TextBlock [ Text = $BannerText, Foreground = @StateWarningInk, TextWrapping = Wrap ]
                    }

                    // Home channel: telemetry the hive sends, not a connection we open.
                    TextBlock [ Text = "Home channel", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,0,6) ]
                    Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,0,16) ] {
                        Grid {
                            ColumnDefinitions {
                                ColumnDefinition [ Width = GridLength.Star ]
                                ColumnDefinition [ Width = GridLength.Star ]
                                ColumnDefinition [ Width = GridLength.Star ]
                            }
                            StackPanel [ Grid.Column = 0, Orientation = Vertical ] {
                                TextBlock [ Text = "Connection", Style = @UiCaption, Foreground = @Fg2 ]
                                TextBlock [ Text = $ConnectionLabel, Foreground = @Fg0 ]
                            }
                            StackPanel [ Grid.Column = 1, Orientation = Vertical ] {
                                TextBlock [ Text = "Last check-in", Style = @UiCaption, Foreground = @Fg2 ]
                                TextBlock [ Text = $LastSeenLabel, Foreground = @Fg0 ]
                            }
                            StackPanel [ Grid.Column = 2, Orientation = Vertical ] {
                                TextBlock [ Text = "Cluster", Style = @UiCaption, Foreground = @Fg2 ]
                                TextBlock [ Text = $ClusterLabel, Foreground = @Fg0 ]
                            }
                        }
                    }

                    // Credentials: referenced by name; values are never shown.
                    TextBlock [ Text = "Credentials", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,0,4) ]
                    TextBlock [ Text = "Referenced by name. No secret value is shown here.",
                                Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,6) ]
                    Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,0,16) ] {
                        ItemsControl [ ItemsSource = $Credentials ]
                    }

                    // Rollout: the target version and each environment against it.
                    TextBlock [ Text = "Rollout", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,0,6) ]
                    Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,0,16) ] {
                        StackPanel [ Orientation = Vertical ] {
                            StackPanel [ Orientation = Horizontal, Margin = (0,0,0,6) ] {
                                TextBlock [ Text = "Target version", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,8,0) ]
                                TextBlock [ Text = $TargetVersionLabel, Style = @Code, Foreground = @Fg0 ]
                            }
                            TextBlock [ Text = "No rollout reported yet.", Foreground = @Fg2,
                                        Visibility = $HasNoRollout << ToVisibility ]
                            ItemsControl [ ItemsSource = $RolloutRows, Visibility = $HasRollout << ToVisibility ]
                        }
                    }

                    // Per-hive release policy (edited in Release Policy).
                    TextBlock [ Text = "Per-hive policy", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,0,6) ]
                    Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,0,16) ] {
                        Grid {
                            ColumnDefinitions {
                                ColumnDefinition [ Width = GridLength.Star ]
                                ColumnDefinition [ Width = GridLength.Star ]
                                ColumnDefinition [ Width = GridLength.Star ]
                            }
                            StackPanel [ Grid.Column = 0, Orientation = Vertical ] {
                                TextBlock [ Text = "Channels", Style = @UiCaption, Foreground = @Fg2 ]
                                TextBlock [ Text = $ChannelsLabel, Foreground = @Fg0 ]
                            }
                            StackPanel [ Grid.Column = 1, Orientation = Vertical ] {
                                TextBlock [ Text = "Minimum version", Style = @UiCaption, Foreground = @Fg2 ]
                                TextBlock [ Text = $MinVersionLabel, Foreground = @Fg0 ]
                            }
                            StackPanel [ Grid.Column = 2, Orientation = Vertical ] {
                                TextBlock [ Text = "Hold", Style = @UiCaption, Foreground = @Fg2 ]
                                TextBlock [ Text = $HoldLabel, Foreground = @Fg0 ]
                            }
                        }
                    }

                    // The environments the hive observes: read-only.
                    ContentControl [ Content = $Observed, Margin = (0,0,0,16) ]

                    // Version history (the adoption ledger).
                    TextBlock [ Text = "Version history", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,0,6) ]
                    Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,0,16) ] {
                        StackPanel [ Orientation = Vertical ] {
                            TextBlock [ Text = "No version changes recorded yet.", Foreground = @Fg2,
                                        Visibility = $HasNoLedger << ToVisibility ]
                            ItemsControl [ ItemsSource = $LedgerRows, Visibility = $HasLedger << ToVisibility ]
                        }
                    }

                    // Recent check-ins.
                    TextBlock [ Text = "Recent check-ins", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,0,6) ]
                    Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10) ] {
                        StackPanel [ Orientation = Vertical ] {
                            TextBlock [ Text = "No check-ins recorded yet.", Foreground = @Fg2,
                                        Visibility = $HasNoCheckIns << ToVisibility ]
                            ItemsControl [ ItemsSource = $CheckIns, Visibility = $HasCheckIns << ToVisibility ]
                        }
                    }
                }
            }
        }
    }

    DataTemplate [ DataType = HiveCredentialViewModel ] {
        Grid [ Margin = (0,2,0,2) ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            TextBlock [ Grid.Column = 0, Text = $Kind, Foreground = @Fg1 ]
            TextBlock [ Grid.Column = 1, Text = $Name, Style = @Code, Foreground = @Fg0 ]
            TextBlock [ Grid.Column = 2, Text = $Status, Foreground = @Fg2 ]
        }
    }

    DataTemplate [ DataType = HiveRolloutRowViewModel ] {
        Grid [ Margin = (0,2,0,2) ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            TextBlock [ Grid.Column = 0, Text = $Environment, Foreground = @Fg0 ]
            TextBlock [ Grid.Column = 1, Text = $RunningImage, Style = @Code, Foreground = @Fg1 ]
            TextBlock [ Grid.Column = 2, Text = $StateLabel, Foreground = @Fg1 ]
        }
    }

    DataTemplate [ DataType = HiveLedgerRowViewModel ] {
        Grid [ Margin = (0,2,0,2) ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            TextBlock [ Grid.Column = 0, Text = $WhenLabel, Foreground = @Fg2 ]
            TextBlock [ Grid.Column = 1, Text = $ActionLabel, Foreground = @Fg0 ]
            TextBlock [ Grid.Column = 2, Text = $Version, Style = @Code, Foreground = @Fg1 ]
        }
    }

    DataTemplate [ DataType = HiveCheckInRowViewModel ] {
        Grid [ Margin = (0,2,0,2) ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            TextBlock [ Grid.Column = 0, Text = $WhenLabel, Foreground = @Fg2 ]
            TextBlock [ Grid.Column = 1, Text = $SummaryLabel, Foreground = @Fg0 ]
        }
    }

    // Create hive: register a hive record for a tenant without one.
    DataTemplate [ DataType = NewHiveDialogViewModel ] {
        StackPanel [ Orientation = Vertical, Margin = (0,4,0,0) ] {
            TextBlock [ Text = "Registers a hive for a tenant that has none. One tenant, one hive. References are names only; no secret value is entered here.",
                        TextWrapping = Wrap, Foreground = @Fg2, Margin = (0,0,0,12) ]
            TextBlock [ Text = "Every tenant already has its hive.", Foreground = @StateWarningInk, Margin = (0,0,0,12),
                        Visibility = $HasNoFreeTenant << ToVisibility ]
            TextBlock [ Text = "Tenant", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            ComboBox [ ItemsSource = $Tenants, SelectedItem = $SelectedTenant, Placeholder = "Choose tenant",
                       HorizontalAlignment = Stretch, Margin = (0,0,0,12) ]
            TextBlock [ Text = "Hive id", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ Text = $Id, Placeholder = "e.g. tailspin-hive", Margin = (0,0,0,12) ]
            TextBlock [ Text = "Display name", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ Text = $DisplayName, Placeholder = "e.g. Tailspin hive", Margin = (0,0,0,12) ]
            Grid [ Margin = (0,0,0,12) ] {
                ColumnDefinitions {
                    ColumnDefinition [ Width = GridLength.Star ]
                    ColumnDefinition [ Width = GridLength.Star ]
                }
                StackPanel [ Grid.Column = 0, Orientation = Vertical, Margin = (0,0,8,0) ] {
                    TextBlock [ Text = "Cluster", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                    ComboBox [ ItemsSource = $Backends, SelectedItem = $SelectedBackend, HorizontalAlignment = Stretch ]
                }
                StackPanel [ Grid.Column = 1, Orientation = Vertical ] {
                    TextBlock [ Text = "Cluster mode", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                    ComboBox [ ItemsSource = $ClusterModes, SelectedItem = $SelectedClusterMode, HorizontalAlignment = Stretch ]
                }
            }
            TextBlock [ Text = "Cluster config reference (optional)", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ Text = $ConfigRef, Margin = (0,0,0,12) ]
            TextBlock [ Text = "Registry mode", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            ComboBox [ ItemsSource = $RegistryModes, SelectedItem = $SelectedRegistryMode, HorizontalAlignment = Stretch, Margin = (0,0,0,12) ]
            TextBlock [ Text = "Registry endpoint (optional)", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ Text = $Endpoint, Margin = (0,0,0,12) ]
            TextBlock [ Text = "Registry credential reference (optional)", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ Text = $CredentialRef, Margin = (0,0,0,12) ]
            TextBlock [ Text = "Trust root reference (optional)", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ Text = $TrustRootRef, Margin = (0,0,0,12) ]
            TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,0,0,12),
                        Visibility = $ErrorText << ToVisibility ]
            StackPanel [ Orientation = Horizontal, HorizontalAlignment = Right ] {
                Button [ Variant = Secondary, Command = $CancelCommand, Margin = (0,0,8,0) ] {
                    TextBlock [ Text = "Cancel" ]
                }
                Button [ Variant = Primary, Command = $ConfirmCommand ] {
                    TextBlock [ Text = "Create hive" ]
                }
            }
        }
    }
}
