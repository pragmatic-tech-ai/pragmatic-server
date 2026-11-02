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
// ProvisionWizardPageViewModel (Stand up a hive) is a page too, not a
// dialog: its step indicator, Back / Next and Submit live inside the page,
// and its last step shows the Owner password and the agent token once, held
// until both "I've saved it" boxes are ticked and Finish is pressed.
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
import ProvisionWizardPageViewModel from "./provision-wizard-page-view-model.js"
import ProvisionStepViewModel from "./provision-wizard-page-view-model.js"

resources HivesResources {
    DataTemplate [ DataType = HivesPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            // Page header: Stand up a hive is the primary action (the
            // provision wizard); Create hive registers a record.
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

            // Populated: the hives table. The page scrolls header and rows
            // together, so both get the same width.
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
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                        }
                        TextBlock [ Grid.Column = 0, Text = "Hive", Style = @PortalTableLinkHeader ]
                        TextBlock [ Grid.Column = 1, Text = "Client / tenant", Style = @PortalTableHeader ]
                        TextBlock [ Grid.Column = 2, Text = "Cluster", Style = @PortalTableHeader ]
                        TextBlock [ Grid.Column = 3, Text = "Connection", Style = @PortalTableHeader ]
                        TextBlock [ Grid.Column = 4, Text = "Health", Style = @PortalTableHeader ]
                        TextBlock [ Grid.Column = 5, Text = "Registry credential", Style = @PortalTableHeader ]
                    }
                    ListBox [ Style = @PortalTableList, HorizontalAlignment = Stretch, ItemsSource = $Rows, ItemTemplate = @HiveRowTemplate ]
                }
            }
        }
    }

    // A hives-table row; the name opens the hive's detail.
    DataTemplate x:key="HiveRowTemplate" [ DataType = HiveRowViewModel ] {
        Grid [ Style = @PortalTableColumns ] {
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

    // The wizard's step indicator lays its steps out in a row.
    ItemsPanelTemplate x:key="ProvisionStepsPanel" {
        StackPanel [ Orientation = Horizontal ]
    }

    // One step of the indicator: its number and label, emphasised when current.
    DataTemplate [ DataType = ProvisionStepViewModel ] {
        StackPanel [ Orientation = Horizontal, Margin = (0,0,20,0) ] {
            Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (8,2,8,2), Margin = (0,0,6,0) ] {
                TextBlock [ Text = $NumberText, Style = @UiCaption, Foreground = @Fg1 ]
            }
            TextBlock [ Text = $Label, Style = @UiLabel, Foreground = @Fg0, VerticalAlignment = Center,
                        Visibility = $IsCurrent << ToVisibility ]
            TextBlock [ Text = $Label, Foreground = @Fg2, VerticalAlignment = Center,
                        Visibility = $IsNotCurrent << ToVisibility ]
        }
    }

    // Stand up a hive: Client, Tenant, Hive, Review, then the one-time Bootstrap.
    DataTemplate [ DataType = ProvisionWizardPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            // Page header.
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Margin = (0,0,0,16) ] {
                TextBlock [ Text = "Stand up a hive", Style = @H3, Foreground = @Fg0 ]
                TextBlock [ Text = "Creates a client, its tenant with a first Owner, and the tenant's hive, then generates the one-time bootstrap. The hive dials home; Pragmatic never connects in.",
                            Style = @Body, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,4,0,0) ]
                TextBlock [ Text = $DeniedReason, Style = @UiCaption, Foreground = @StateWarningInk, Margin = (0,4,0,0),
                            Visibility = $DeniedReason << ToVisibility ]
            }

            // Step indicator.
            ItemsControl [ DockPanel.Dock = Top, ItemsSource = $Steps, ItemsPanel = @ProvisionStepsPanel, Margin = (0,0,0,20) ]

            // Wizard footer: Cancel and Back on the left; Next, Submit or Finish on the right.
            DockPanel [ DockPanel.Dock = Bottom, Margin = (0,16,0,0) ] {
                Button [ DockPanel.Dock = Right, Variant = Primary, Command = $NextCommand,
                         Visibility = $IsInputStep << ToVisibility ] {
                    TextBlock [ Text = "Next" ]
                }
                Button [ DockPanel.Dock = Right, Variant = Primary, Command = $SubmitCommand,
                         Visibility = $IsReviewStep << ToVisibility ] {
                    TextBlock [ Text = "Stand up hive" ]
                }
                Button [ DockPanel.Dock = Right, Variant = Primary, Command = $FinishCommand,
                         Visibility = $IsBootstrapStep << ToVisibility ] {
                    TextBlock [ Text = "Finish" ]
                }
                StackPanel [ Orientation = Horizontal, Visibility = $IsFormStep << ToVisibility ] {
                    Button [ Variant = Secondary, Command = $CancelCommand, Margin = (0,0,8,0) ] {
                        TextBlock [ Text = "Cancel" ]
                    }
                    Button [ Variant = Secondary, Command = $BackStepCommand ] {
                        TextBlock [ Text = "Back" ]
                    }
                }
            }

            ScrollViewer [ HorizontalScrollEnabled = false ] {
                StackPanel [ Orientation = Vertical ] {
                    // Step 1: the client.
                    StackPanel [ Orientation = Vertical, Visibility = $IsClientStep << ToVisibility ] {
                        TextBlock [ Text = "Which client is this hive for?", Style = @UiLabel, Foreground = @Fg0, Margin = (0,0,0,4) ]
                        TextBlock [ Text = "A new client is created. Its id is permanent.", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,12) ]
                        TextBlock [ Text = "Client id", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                        TextBox [ Text = $ClientId, Placeholder = "e.g. tailspin", Margin = (0,0,0,12) ]
                        TextBlock [ Text = "Display name", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                        TextBox [ Text = $ClientDisplayName, Placeholder = "e.g. Tailspin Toys", Margin = (0,0,0,12) ]
                        TextBlock [ Text = "Subscription reference (optional)", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                        TextBox [ Text = $SubscriptionRef ]
                    }

                    // Step 2: the tenant and its first Owner.
                    StackPanel [ Orientation = Vertical, Visibility = $IsTenantStep << ToVisibility ] {
                        TextBlock [ Text = "Which tenant will the hive serve?", Style = @UiLabel, Foreground = @Fg0, Margin = (0,0,0,4) ]
                        TextBlock [ Text = "A new tenant is created for the client. Each hive serves exactly one tenant. Its first Owner receives a one-time password.",
                                    Style = @UiCaption, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,0,0,12) ]
                        TextBlock [ Text = "Tenant id", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                        TextBox [ Text = $TenantId, Placeholder = "e.g. tailspin-prod", Margin = (0,0,0,12) ]
                        TextBlock [ Text = "Display name", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                        TextBox [ Text = $TenantDisplayName, Placeholder = "e.g. Tailspin Production", Margin = (0,0,0,12) ]
                        TextBlock [ Text = "Owner email", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                        TextBox [ Text = $OwnerEmail, Placeholder = "e.g. owner@tailspin.example" ]
                    }

                    // Step 3: the hive. References are names only; no secret value is entered here.
                    StackPanel [ Orientation = Vertical, Visibility = $IsHiveStep << ToVisibility ] {
                        TextBlock [ Text = "Where will the client install it?", Style = @UiLabel, Foreground = @Fg0, Margin = (0,0,0,4) ]
                        TextBlock [ Text = "References are names only; no secret value is entered here. Nothing is contacted.",
                                    Style = @UiCaption, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,0,0,12) ]
                        TextBlock [ Text = "Hive id", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                        TextBox [ Text = $HiveId, Placeholder = "e.g. tailspin-hive", Margin = (0,0,0,12) ]
                        TextBlock [ Text = "Display name", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                        TextBox [ Text = $HiveDisplayName, Placeholder = "e.g. Tailspin hive", Margin = (0,0,0,12) ]
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
                        TextBox [ Text = $TrustRootRef ]
                    }

                    // Step 4: review, then stand it up.
                    StackPanel [ Orientation = Vertical, Visibility = $IsReviewStep << ToVisibility ] {
                        TextBlock [ Text = "Review", Style = @UiLabel, Foreground = @Fg0, Margin = (0,0,0,4) ]
                        TextBlock [ Text = "Standing up creates the client, the tenant with its first Owner, the hive record and a one-time bootstrap.",
                                    Style = @UiCaption, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,0,0,12) ]
                        Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,0,12) ] {
                            Grid {
                                ColumnDefinitions {
                                    ColumnDefinition [ Width = GridLength.Star ]
                                    ColumnDefinition [ Width = GridLength.Star ]
                                    ColumnDefinition [ Width = GridLength.Star ]
                                }
                                StackPanel [ Grid.Column = 0, Orientation = Vertical ] {
                                    TextBlock [ Text = "Client", Style = @UiCaption, Foreground = @Fg2 ]
                                    TextBlock [ Text = $ClientDisplayName, Foreground = @Fg0 ]
                                    TextBlock [ Text = $ClientId, Style = @Code, Foreground = @Fg2 ]
                                }
                                StackPanel [ Grid.Column = 1, Orientation = Vertical ] {
                                    TextBlock [ Text = "Tenant", Style = @UiCaption, Foreground = @Fg2 ]
                                    TextBlock [ Text = $TenantDisplayName, Foreground = @Fg0 ]
                                    TextBlock [ Text = $TenantId, Style = @Code, Foreground = @Fg2 ]
                                    TextBlock [ Text = $OwnerEmail, Foreground = @Fg1 ]
                                }
                                StackPanel [ Grid.Column = 2, Orientation = Vertical ] {
                                    TextBlock [ Text = "Hive", Style = @UiCaption, Foreground = @Fg2 ]
                                    TextBlock [ Text = $HiveDisplayName, Foreground = @Fg0 ]
                                    TextBlock [ Text = $HiveId, Style = @Code, Foreground = @Fg2 ]
                                    StackPanel [ Orientation = Horizontal ] {
                                        TextBlock [ Text = "Cluster:", Foreground = @Fg2, Margin = (0,0,4,0) ]
                                        TextBlock [ Text = $ClusterSummary, Foreground = @Fg1 ]
                                    }
                                    StackPanel [ Orientation = Horizontal ] {
                                        TextBlock [ Text = "Registry:", Foreground = @Fg2, Margin = (0,0,4,0) ]
                                        TextBlock [ Text = $RegistrySummary, Foreground = @Fg1 ]
                                    }
                                }
                            }
                        }
                        TextBlock [ Text = "Standing up the hive...", Foreground = @Fg2, Margin = (0,0,0,8),
                                    Visibility = $IsSubmitting << ToVisibility ]
                        TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap,
                                    Visibility = $ErrorText << ToVisibility ]
                    }

                    // Step 5: the one-time Bootstrap values. Shown once; Finish needs both boxes ticked.
                    StackPanel [ Orientation = Vertical, Visibility = $IsBootstrapStep << ToVisibility ] {
                        Border [ Fill = @StateSuccessSoft, Padding = (12,10,12,10), Margin = (0,0,0,12) ] {
                            StackPanel [ Orientation = Horizontal ] {
                                TextBlock [ Text = "Hive", Foreground = @StateSuccessInk, Margin = (0,0,4,0) ]
                                TextBlock [ Text = $ProvisionedHiveId, Style = @Code, Foreground = @StateSuccessInk, Margin = (0,0,4,0) ]
                                TextBlock [ Text = "is created and waiting for its first dial-in.", Foreground = @StateSuccessInk ]
                            }
                        }
                        Border [ Fill = @StateWarningSoft, Padding = (12,10,12,10), Margin = (0,0,0,16) ] {
                            TextBlock [ Text = "These values are shown once and cannot be shown again. Copy each now and pass it on over a secure channel.",
                                        Foreground = @StateWarningInk, TextWrapping = Wrap ]
                        }

                        StackPanel [ Orientation = Horizontal, Margin = (0,0,0,6) ] {
                            TextBlock [ Text = "Owner password for", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,4,0) ]
                            TextBlock [ Text = $OwnerEmail, Foreground = @Fg0 ]
                        }
                        Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,0,8) ] {
                            DockPanel {
                                Button [ DockPanel.Dock = Right, Variant = Secondary, Command = $CopyOwnerPasswordCommand, Margin = (12,0,0,0) ] {
                                    TextBlock [ Text = "Copy" ]
                                }
                                TextBlock [ Text = $OwnerPassword, Style = @Code, Foreground = @Fg0, VerticalAlignment = Center ]
                            }
                        }
                        TextBlock [ Text = $OwnerCopyStatus, Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,8),
                                    Visibility = $OwnerCopyStatus << ToVisibility ]
                        StackPanel [ Orientation = Horizontal, Margin = (0,0,0,16) ] {
                            Checkbox [ IsChecked = $OwnerSaved, VerticalAlignment = Center, Margin = (0,0,8,0) ]
                            TextBlock [ Text = "I've saved the Owner password", Foreground = @Fg0, VerticalAlignment = Center ]
                        }

                        TextBlock [ Text = "One-time agent token", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,0,2) ]
                        TextBlock [ Text = "The client applies it with the bootstrap. The Agent exchanges it on first dial-in; then it is useless.",
                                    Style = @UiCaption, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,0,0,6) ]
                        Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,0,8) ] {
                            DockPanel {
                                Button [ DockPanel.Dock = Right, Variant = Secondary, Command = $CopyAgentTokenCommand, Margin = (12,0,0,0) ] {
                                    TextBlock [ Text = "Copy" ]
                                }
                                TextBlock [ Text = $AgentToken, Style = @Code, Foreground = @Fg0, VerticalAlignment = Center, TextWrapping = Wrap ]
                            }
                        }
                        TextBlock [ Text = $AgentCopyStatus, Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,8),
                                    Visibility = $AgentCopyStatus << ToVisibility ]
                        StackPanel [ Orientation = Horizontal, Margin = (0,0,0,8) ] {
                            Checkbox [ IsChecked = $AgentSaved, VerticalAlignment = Center, Margin = (0,0,8,0) ]
                            TextBlock [ Text = "I've saved the agent token", Foreground = @Fg0, VerticalAlignment = Center ]
                        }
                    }
                }
            }
        }
    }
}
