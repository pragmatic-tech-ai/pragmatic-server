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
// and its last step shows the agent token (and a new tenant's Owner password)
// once, with the agent's install panel, held until every shown "I've saved
// it" box is ticked and Finish is pressed.
//
// HiveInstallViewModel (the agent's install bundle and kubectl commands) is
// shared by the wizard's Bootstrap step, the hive detail and the reissued
// token's reveal (AgentTokenRevealPageViewModel, a page like the wizard).
//
// HiveAgentInstallViewModel is the automatic install of a Local hive's agent
// (the control plane runs every step itself): Install agent, its step list,
// Connected or the error with Retry. The wizard's Bootstrap step and the hive
// detail show it for a Local hive, with the manual install behind
// Install manually; any other hive keeps the manual install only.
//
// HiveConsoleViewModel is the same Local hive's tenant console on the hive
// detail: where it is served (base domain, host, TLS source; development
// self-signed is labelled development only), Install console with the same
// step rows, the console address and the development CA trust command once
// deployed (with Copy), and Set Owner password (any configured console), whose
// reply shows once in the panel with Copy and is cleared when the page is left.
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
import HiveInstallViewModel from "./hive-install-view-model.js"
import AgentTokenRevealPageViewModel from "./agent-token-reveal-page-view-model.js"
import HiveAgentInstallViewModel from "./hive-agent-install-view-model.js"
import AgentInstallStepViewModel from "./hive-agent-install-view-model.js"
import HiveConsoleViewModel from "./hive-console-view-model.js"

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

            // What the last hive delete kept or may have left behind, until dismissed.
            Border [ DockPanel.Dock = Top, Fill = @StateSuccessSoft, Padding = (12,10,12,10), Margin = (0,0,0,16),
                     Visibility = $HasNotice << ToVisibility ] {
                DockPanel {
                    Button [ DockPanel.Dock = Right, Variant = Ghost, Command = $DismissNoticeCommand, VerticalAlignment = Top, Margin = (12,0,0,0) ] {
                        TextBlock [ Text = "Dismiss" ]
                    }
                    TextBlock [ Text = $NoticeText, Foreground = @StateSuccessInk, TextWrapping = Wrap ]
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
                Button [ DockPanel.Dock = Right, Variant = Secondary, Command = $ReissueTokenCommand, VerticalAlignment = Top, Margin = (0,0,8,0),
                         Visibility = $IsManualOnly << ToVisibility ] {
                    TextBlock [ Text = "Reissue agent token" ]
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

                    // A delete that could not remove the agent from its cluster: the reason and Delete anyway.
                    Border [ Fill = @StateWarningSoft, Padding = (12,10,12,10), Margin = (0,0,0,16),
                             Visibility = $CanDeleteAnyway << ToVisibility ] {
                        DockPanel {
                            Button [ DockPanel.Dock = Right, Variant = Danger, Command = $DeleteAnywayCommand, VerticalAlignment = Top, Margin = (12,0,0,0) ] {
                                TextBlock [ Text = "Delete anyway" ]
                            }
                            TextBlock [ Text = $DeleteAnywayText, Foreground = @StateDangerInk, TextWrapping = Wrap ]
                        }
                    }

                    // The agent install: automatic for a Local hive (the control plane runs it), else the manual bundle.
                    TextBlock [ Text = "Agent install", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,0,2) ]
                    StackPanel [ Orientation = Vertical, Visibility = $IsAutoInstall << ToVisibility ] {
                        TextBlock [ Text = "Pragmatic manages this hive's cluster, so it installs the agent itself: no token or commands to pass on. Installing again issues a fresh token and restarts the agent.",
                                    Style = @UiCaption, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,0,0,6) ]
                        ContentControl [ Content = $AgentInstall, Margin = (0,0,0,4) ]
                        Button [ Variant = Ghost, Command = $ToggleManualCommand, HorizontalAlignment = Left, Margin = (0,0,0,8) ] {
                            TextBlock [ Text = $ManualToggleLabel ]
                        }
                    }
                    StackPanel [ Orientation = Vertical, Visibility = $ShowsManual << ToVisibility ] {
                        TextBlock [ Text = "Neither the bundle nor the commands carry the agent token; it is typed in at the prompt. Reissue the token if it was lost.",
                                    Style = @UiCaption, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,0,0,6) ]
                        Button [ Variant = Secondary, Command = $ReissueTokenCommand, HorizontalAlignment = Left, Margin = (0,0,0,8),
                                 Visibility = $IsAutoInstall << ToVisibility ] {
                            TextBlock [ Text = "Reissue agent token" ]
                        }
                        ContentControl [ Content = $Install, Margin = (0,0,0,16) ]
                    }

                    // The tenant console in this hive: its settings, its install and the Owner password (Local hives).
                    StackPanel [ Orientation = Vertical, Margin = (0,0,0,16), Visibility = $IsAutoInstall << ToVisibility ] {
                        TextBlock [ Text = "Tenant console", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,0,2) ]
                        TextBlock [ Text = "Run the tenant's console in this hive. Pragmatic installs it with its identity provider; the tenant's environments are then managed from inside the hive.",
                                    Style = @UiCaption, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,0,0,6) ]
                        ContentControl [ Content = $Console ]
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
                        ListBox [ Style = @PortalTableList, HorizontalAlignment = Stretch, ItemsSource = $Credentials, ItemTemplate = @HiveCredentialRowTemplate ]
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
                            ListBox [ Style = @PortalTableList, HorizontalAlignment = Stretch, ItemsSource = $RolloutRows, ItemTemplate = @HiveRolloutRowTemplate,
                                      Visibility = $HasRollout << ToVisibility ]
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
                            ListBox [ Style = @PortalTableList, HorizontalAlignment = Stretch, ItemsSource = $LedgerRows, ItemTemplate = @HiveLedgerRowTemplate,
                                      Visibility = $HasLedger << ToVisibility ]
                        }
                    }

                    // Recent check-ins.
                    TextBlock [ Text = "Recent check-ins", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,0,6) ]
                    Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10) ] {
                        StackPanel [ Orientation = Vertical ] {
                            TextBlock [ Text = "No check-ins recorded yet.", Foreground = @Fg2,
                                        Visibility = $HasNoCheckIns << ToVisibility ]
                            ListBox [ Style = @PortalTableList, HorizontalAlignment = Stretch, ItemsSource = $CheckIns, ItemTemplate = @HiveCheckInRowTemplate,
                                      Visibility = $HasCheckIns << ToVisibility ]
                        }
                    }
                }
            }
        }
    }

    DataTemplate x:key="HiveCredentialRowTemplate" [ DataType = HiveCredentialViewModel ] {
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

    DataTemplate x:key="HiveRolloutRowTemplate" [ DataType = HiveRolloutRowViewModel ] {
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

    DataTemplate x:key="HiveLedgerRowTemplate" [ DataType = HiveLedgerRowViewModel ] {
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

    DataTemplate x:key="HiveCheckInRowTemplate" [ DataType = HiveCheckInRowViewModel ] {
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
            TextBox [ UsesNativeInput = true, Text = $Id, Placeholder = "e.g. tailspin-hive", Margin = (0,0,0,12) ]
            TextBlock [ Text = $IdHint, Style = @UiCaption, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,0,0,12),
                        Visibility = $IdHint << ToVisibility ]
            TextBlock [ Text = "Display name", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ UsesNativeInput = true, Text = $DisplayName, Placeholder = "e.g. Tailspin hive", Margin = (0,0,0,12) ]
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
            TextBox [ UsesNativeInput = true, Text = $ConfigRef, Margin = (0,0,0,12) ]
            TextBlock [ Text = "Registry mode", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            ComboBox [ ItemsSource = $RegistryModes, SelectedItem = $SelectedRegistryMode, HorizontalAlignment = Stretch, Margin = (0,0,0,12) ]
            TextBlock [ Text = "Registry endpoint (optional)", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ UsesNativeInput = true, Text = $Endpoint, Margin = (0,0,0,12) ]
            TextBlock [ Text = "Registry credential reference (optional)", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ UsesNativeInput = true, Text = $CredentialRef, Margin = (0,0,0,12) ]
            TextBlock [ Text = "Trust root reference (optional; empty uses the platform signing key)", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ UsesNativeInput = true, Text = $TrustRootRef, Margin = (0,0,0,12) ]
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
                TextBlock [ Text = "Creates a hive for a new or existing tenant (and client), then generates the one-time bootstrap. The hive dials home; Pragmatic never connects in.",
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
                        TextBlock [ Text = "Pick an existing client, or New client to create one. A new client's id is permanent.",
                                    Style = @UiCaption, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,0,0,12) ]
                        TextBlock [ Text = "Client", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                        ComboBox [ ItemsSource = $Clients, SelectedItem = $SelectedClient, HorizontalAlignment = Stretch, Margin = (0,0,0,12) ]
                        StackPanel [ Orientation = Vertical, Visibility = $IsNewClient << ToVisibility ] {
                            TextBlock [ Text = "Client id", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                            TextBox [ UsesNativeInput = true, Text = $ClientId, Placeholder = "e.g. tailspin", Margin = (0,0,0,12) ]
                            TextBlock [ Text = "Display name", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                            TextBox [ UsesNativeInput = true, Text = $ClientDisplayName, Placeholder = "e.g. Tailspin Toys", Margin = (0,0,0,12) ]
                            TextBlock [ Text = "Subscription reference (optional)", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                            TextBox [ UsesNativeInput = true, Text = $SubscriptionRef ]
                        }
                        TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,12,0,0),
                                    Visibility = $ErrorText << ToVisibility ]
                    }

                    // Step 2: the tenant (and, for a new one, its first Owner).
                    StackPanel [ Orientation = Vertical, Visibility = $IsTenantStep << ToVisibility ] {
                        TextBlock [ Text = "Which tenant will the hive serve?", Style = @UiLabel, Foreground = @Fg0, Margin = (0,0,0,4) ]
                        TextBlock [ Text = "Pick one of the client's tenants, or New tenant to create one. Each hive serves exactly one tenant. A new tenant's first Owner receives a one-time password.",
                                    Style = @UiCaption, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,0,0,12) ]
                        TextBlock [ Text = "Tenant", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                        ComboBox [ ItemsSource = $Tenants, SelectedItem = $SelectedTenant, HorizontalAlignment = Stretch, Margin = (0,0,0,12) ]
                        StackPanel [ Orientation = Vertical, Visibility = $IsNewTenant << ToVisibility ] {
                            TextBlock [ Text = "Tenant id", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                            TextBox [ UsesNativeInput = true, Text = $TenantId, Placeholder = "e.g. tailspin-prod", Margin = (0,0,0,12) ]
                            TextBlock [ Text = "Display name", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                            TextBox [ UsesNativeInput = true, Text = $TenantDisplayName, Placeholder = "e.g. Tailspin Production", Margin = (0,0,0,12) ]
                            TextBlock [ Text = "Owner email", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                            TextBox [ UsesNativeInput = true, InputPurpose = Email, Text = $OwnerEmail, Placeholder = "e.g. owner@tailspin.example" ]
                        }
                    }

                    // Step 3: the hive. References are names only; no secret value is entered here.
                    StackPanel [ Orientation = Vertical, Visibility = $IsHiveStep << ToVisibility ] {
                        TextBlock [ Text = "Where will the client install it?", Style = @UiLabel, Foreground = @Fg0, Margin = (0,0,0,4) ]
                        TextBlock [ Text = "References are names only; no secret value is entered here. Nothing is contacted.",
                                    Style = @UiCaption, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,0,0,12) ]
                        TextBlock [ Text = "Hive id", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                        TextBox [ UsesNativeInput = true, Text = $HiveId, Placeholder = "e.g. tailspin-hive", Margin = (0,0,0,12) ]
                        TextBlock [ Text = $HiveIdHint, Style = @UiCaption, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,0,0,12),
                                    Visibility = $HiveIdHint << ToVisibility ]
                        TextBlock [ Text = "Display name", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                        TextBox [ UsesNativeInput = true, Text = $HiveDisplayName, Placeholder = "e.g. Tailspin hive", Margin = (0,0,0,12) ]
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
                        TextBox [ UsesNativeInput = true, Text = $ConfigRef, Margin = (0,0,0,12) ]
                        TextBlock [ Text = "Registry mode", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                        ComboBox [ ItemsSource = $RegistryModes, SelectedItem = $SelectedRegistryMode, HorizontalAlignment = Stretch, Margin = (0,0,0,12) ]
                        TextBlock [ Text = "Registry endpoint (optional)", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                        TextBox [ UsesNativeInput = true, Text = $Endpoint, Margin = (0,0,0,12) ]
                        TextBlock [ Text = "Registry credential reference (optional)", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                        TextBox [ UsesNativeInput = true, Text = $CredentialRef, Margin = (0,0,0,12) ]
                        TextBlock [ Text = "Trust root reference (optional; empty uses the platform signing key)", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                        TextBox [ UsesNativeInput = true, Text = $TrustRootRef ]
                    }

                    // Step 4: review, then stand it up.
                    StackPanel [ Orientation = Vertical, Visibility = $IsReviewStep << ToVisibility ] {
                        TextBlock [ Text = "Review", Style = @UiLabel, Foreground = @Fg0, Margin = (0,0,0,4) ]
                        TextBlock [ Text = $ReviewCaption, Style = @UiCaption, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,0,0,12) ]
                        Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,0,12) ] {
                            Grid {
                                ColumnDefinitions {
                                    ColumnDefinition [ Width = GridLength.Star ]
                                    ColumnDefinition [ Width = GridLength.Star ]
                                    ColumnDefinition [ Width = GridLength.Star ]
                                }
                                StackPanel [ Grid.Column = 0, Orientation = Vertical ] {
                                    TextBlock [ Text = $ReviewClientCaption, Style = @UiCaption, Foreground = @Fg2 ]
                                    TextBlock [ Text = $ReviewClientName, Foreground = @Fg0 ]
                                    TextBlock [ Text = $ReviewClientId, Style = @Code, Foreground = @Fg2 ]
                                }
                                StackPanel [ Grid.Column = 1, Orientation = Vertical ] {
                                    TextBlock [ Text = $ReviewTenantCaption, Style = @UiCaption, Foreground = @Fg2 ]
                                    TextBlock [ Text = $ReviewTenantName, Foreground = @Fg0 ]
                                    TextBlock [ Text = $ReviewTenantId, Style = @Code, Foreground = @Fg2 ]
                                    TextBlock [ Text = $ReviewOwnerEmail, Foreground = @Fg1, Visibility = $ReviewOwnerEmail << ToVisibility ]
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

                    // Step 5: the one-time Bootstrap values. Shown once; Finish needs every shown box ticked.
                    StackPanel [ Orientation = Vertical, Visibility = $IsBootstrapStep << ToVisibility ] {
                        Border [ Fill = @StateSuccessSoft, Padding = (12,10,12,10), Margin = (0,0,0,12) ] {
                            StackPanel [ Orientation = Horizontal ] {
                                TextBlock [ Text = "Hive", Foreground = @StateSuccessInk, Margin = (0,0,4,0) ]
                                TextBlock [ Text = $ProvisionedHiveId, Style = @Code, Foreground = @StateSuccessInk, Margin = (0,0,4,0) ]
                                TextBlock [ Text = "is created and waiting for its first dial-in.", Foreground = @StateSuccessInk ]
                            }
                        }
                        Border [ Fill = @StateWarningSoft, Padding = (12,10,12,10), Margin = (0,0,0,16),
                                 Visibility = $ShowsOneTimeValues << ToVisibility ] {
                            TextBlock [ Text = "These values are shown once and cannot be shown again. Copy each now and pass it on over a secure channel.",
                                        Foreground = @StateWarningInk, TextWrapping = Wrap ]
                        }

                        // A new tenant's Owner password; an existing tenant reveals none.
                        StackPanel [ Orientation = Vertical, Visibility = $RevealsOwner << ToVisibility ] {
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
                        }

                        // A Local hive: the control plane installs the agent itself; the provision's token is never shown.
                        StackPanel [ Orientation = Vertical, Visibility = $IsAutomaticInstall << ToVisibility ] {
                            TextBlock [ Text = "Installing the agent", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,0,2) ]
                            TextBlock [ Text = "Pragmatic manages this hive's cluster, so it installs the agent itself: no token or commands to pass on.",
                                        Style = @UiCaption, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,0,0,6) ]
                            ContentControl [ Content = $AgentInstall, Margin = (0,0,0,4) ]
                            Button [ Variant = Ghost, Command = $ToggleManualCommand, HorizontalAlignment = Left, Margin = (0,0,0,8),
                                     Visibility = $CanInstallManually << ToVisibility ] {
                                TextBlock [ Text = $ManualToggleLabel ]
                            }
                            StackPanel [ Orientation = Vertical, Margin = (0,0,0,8), Visibility = $ShowsManualInstall << ToVisibility ] {
                                TextBlock [ Text = "Install it by hand instead: issue a one-time token, then send it with the bundle and commands below to the cluster's administrator.",
                                            Style = @UiCaption, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,0,0,6) ]
                                Button [ Variant = Secondary, Command = $IssueManualTokenCommand, HorizontalAlignment = Left ] {
                                    TextBlock [ Text = "Issue agent token" ]
                                }
                            }
                        }

                        StackPanel [ Orientation = Vertical, Visibility = $ShowsAgentToken << ToVisibility ] {
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
                            StackPanel [ Orientation = Horizontal, Margin = (0,0,0,16) ] {
                                Checkbox [ IsChecked = $AgentSaved, VerticalAlignment = Center, Margin = (0,0,8,0) ]
                                TextBlock [ Text = "I've saved the agent token", Foreground = @Fg0, VerticalAlignment = Center ]
                            }
                        }

                        StackPanel [ Orientation = Vertical, Visibility = $IsManualInstall << ToVisibility ] {
                            TextBlock [ Text = "Install the agent", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,0,2) ]
                            TextBlock [ Text = "Send the bundle and these commands to the client's cluster administrator. Once applied, the hive dials home.",
                                        Style = @UiCaption, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,0,0,6) ]
                        }
                        ContentControl [ Content = $Install, Visibility = $ShowsInstallPanel << ToVisibility ]
                    }
                }
            }
        }
    }

    // The agent's install panel: bundle download, where the agent dials, and the commands.
    DataTemplate [ DataType = HiveInstallViewModel ] {
        StackPanel [ Orientation = Vertical ] {
            TextBlock [ Text = "Loading the install bundle...", Foreground = @Fg2, Visibility = $IsLoading << ToVisibility ]
            Border [ Fill = @StateWarningSoft, Padding = (12,10,12,10), Visibility = $ErrorText << ToVisibility ] {
                TextBlock [ Text = $ErrorText, Foreground = @StateWarningInk, TextWrapping = Wrap ]
            }
            StackPanel [ Orientation = Vertical, Visibility = $HasBundle << ToVisibility ] {
                Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,0,8) ] {
                    DockPanel {
                        Button [ DockPanel.Dock = Right, Variant = Secondary, Command = $DownloadCommand, Margin = (12,0,0,0) ] {
                            TextBlock [ Text = "Download bundle" ]
                        }
                        StackPanel [ Orientation = Vertical, VerticalAlignment = Center ] {
                            TextBlock [ Text = $FileName, Style = @Code, Foreground = @Fg0 ]
                            StackPanel [ Orientation = Horizontal, Margin = (0,2,0,0) ] {
                                TextBlock [ Text = "The agent dials", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,4,0) ]
                                TextBlock [ Text = $ChannelUrl, Style = @UiCaption, Foreground = @Fg1 ]
                            }
                        }
                    }
                }
                Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,0,4) ] {
                    DockPanel {
                        Button [ DockPanel.Dock = Right, Variant = Secondary, Command = $CopyCommandsCommand, VerticalAlignment = Top, Margin = (12,0,0,0) ] {
                            TextBlock [ Text = "Copy commands" ]
                        }
                        TextBlock [ Text = $Commands, Style = @Code, Foreground = @Fg0, TextWrapping = Wrap ]
                    }
                }
                TextBlock [ Text = $Status, Style = @UiCaption, Foreground = @Fg2, Visibility = $Status << ToVisibility ]
            }
        }
    }

    // The automatic agent install: Install agent, then each real step as the control plane runs it,
    // ending Connected (the agent checked in) or on the failed step's error with Retry.
    DataTemplate [ DataType = HiveAgentInstallViewModel ] {
        StackPanel [ Orientation = Vertical ] {
            Button [ Variant = Primary, Command = $StartCommand, HorizontalAlignment = Left, Margin = (0,0,0,8),
                     Visibility = $IsIdle << ToVisibility ] {
                TextBlock [ Text = "Install agent" ]
            }
            Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,0,8),
                     Visibility = $HasProgress << ToVisibility ] {
                StackPanel [ Orientation = Vertical ] {
                    ItemsControl [ ItemsSource = $Steps, ItemsPanel = @AgentInstallStepsPanel ]
                    TextBlock [ Text = $StatusText, Foreground = @Fg1, TextWrapping = Wrap, Margin = (0,8,0,0) ]
                }
            }
            Border [ Fill = @StateSuccessSoft, Padding = (12,10,12,10), Margin = (0,0,0,8), Visibility = $IsConnected << ToVisibility ] {
                TextBlock [ Text = "Connected", Foreground = @StateSuccessInk ]
            }
            Border [ Fill = @StateWarningSoft, Padding = (12,10,12,10), Margin = (0,0,0,8), Visibility = $ErrorText << ToVisibility ] {
                TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap ]
            }
            StackPanel [ Orientation = Horizontal ] {
                Button [ Variant = Primary, Command = $RetryCommand, Margin = (0,0,8,0), Visibility = $IsFailed << ToVisibility ] {
                    TextBlock [ Text = "Retry" ]
                }
                Button [ Variant = Secondary, Command = $StartCommand, Visibility = $IsConnected << ToVisibility ] {
                    TextBlock [ Text = "Reinstall agent" ]
                }
            }
        }
    }

    // The tenant console: settings (Save, Remove with its confirmation), Install console with its steps, then the
    // address, the development CA trust command and Set Owner password (its reply shown once).
    DataTemplate [ DataType = HiveConsoleViewModel ] {
        StackPanel [ Orientation = Vertical ] {
            Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,0,8) ] {
                StackPanel [ Orientation = Vertical ] {
                    TextBlock [ Text = "Base domain", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                    TextBox [ UsesNativeInput = true, Text = $BaseDomain, Placeholder = "e.g. localtest.me", Margin = (0,0,0,12) ]
                    TextBlock [ Text = "Console host (optional)", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                    TextBox [ UsesNativeInput = true, Text = $Host, Placeholder = $HostPlaceholder, Margin = (0,0,0,12) ]
                    TextBlock [ Text = "Ingress controller namespace (optional; only it may reach the console)", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                    TextBox [ UsesNativeInput = true, Text = $IngressNamespace, Placeholder = $IngressNamespacePlaceholder, Margin = (0,0,0,12) ]
                    TextBlock [ Text = "TLS certificate", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                    ComboBox [ ItemsSource = $TlsOptions, SelectedItem = $SelectedTls, HorizontalAlignment = Stretch, Margin = (0,0,0,12) ]
                    StackPanel [ Orientation = Vertical, Visibility = $IsExistingSecret << ToVisibility ] {
                        TextBlock [ Text = "TLS Secret name (a kubernetes.io/tls Secret in pragmatic-system)", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                        TextBox [ UsesNativeInput = true, Text = $SecretName, Placeholder = "e.g. acme-console-tls", Margin = (0,0,0,12) ]
                    }
                    StackPanel [ Orientation = Vertical, Visibility = $IsCertManager << ToVisibility ] {
                        TextBlock [ Text = "cert-manager ClusterIssuer", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                        TextBox [ UsesNativeInput = true, Text = $ClusterIssuer, Placeholder = "e.g. letsencrypt", Margin = (0,0,0,12) ]
                    }
                    Border [ Fill = @StateWarningSoft, Padding = (12,10,12,10), Margin = (0,0,0,12), Visibility = $IsDevelopment << ToVisibility ] {
                        TextBlock [ Text = "Development only. The certificates come from this control plane's development CA: only a machine that trusts that CA trusts them. The console host must be the base domain or a name under it.",
                                    Foreground = @StateWarningInk, TextWrapping = Wrap ]
                    }
                    StackPanel [ Orientation = Horizontal ] {
                        Button [ Variant = Primary, Command = $SaveCommand, Margin = (0,0,8,0) ] {
                            TextBlock [ Text = "Save settings" ]
                        }
                        Button [ Variant = Secondary, Command = $RemoveCommand, Visibility = $IsConfigured << ToVisibility ] {
                            TextBlock [ Text = "Remove console" ]
                        }
                    }
                }
            }
            Border [ Fill = @StateWarningSoft, Padding = (12,10,12,10), Margin = (0,0,0,8), Visibility = $IsConfirmingRemove << ToVisibility ] {
                DockPanel {
                    StackPanel [ DockPanel.Dock = Right, Orientation = Horizontal, VerticalAlignment = Top, Margin = (12,0,0,0) ] {
                        Button [ Variant = Secondary, Command = $CancelRemoveCommand, Margin = (0,0,8,0) ] {
                            TextBlock [ Text = "Keep it" ]
                        }
                        Button [ Variant = Danger, Command = $ConfirmRemoveCommand ] {
                            TextBlock [ Text = "Remove console" ]
                        }
                    }
                    TextBlock [ Text = "Remove the console from this hive? Its objects, its cluster-wide grants and its identity provider's workload are deleted from the cluster. Its data volume, its identity provider's data and Secrets, and the environments it created are kept: those environments keep running unmanaged until the console is reinstalled, and are removed with the hive.",
                                Foreground = @StateWarningInk, TextWrapping = Wrap ]
                }
            }
            Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,0,8), Visibility = $RemovalNote << ToVisibility ] {
                TextBlock [ Text = $RemovalNote, Foreground = @Fg1, TextWrapping = Wrap ]
            }
            TextBlock [ Text = "Save the settings first, then install the console.", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,8),
                        Visibility = $IsNotConfigured << ToVisibility ]
            Button [ Variant = Primary, Command = $InstallCommand, HorizontalAlignment = Left, Margin = (0,0,0,8),
                     Visibility = $IsIdle << ToVisibility ] {
                TextBlock [ Text = "Install console" ]
            }
            Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,0,8),
                     Visibility = $HasProgress << ToVisibility ] {
                StackPanel [ Orientation = Vertical ] {
                    ItemsControl [ ItemsSource = $Steps, ItemsPanel = @AgentInstallStepsPanel ]
                    TextBlock [ Text = $StatusText, Foreground = @Fg1, TextWrapping = Wrap, Margin = (0,8,0,0) ]
                }
            }
            StackPanel [ Orientation = Horizontal, Margin = (0,0,0,8), Visibility = $HasConsoleUrl << ToVisibility ] {
                TextBlock [ Text = "Console address", Style = @UiCaption, Foreground = @Fg2, VerticalAlignment = Center, Margin = (0,0,8,0) ]
                TextBlock [ Text = $ConsoleUrl, Style = @Code, Foreground = @Fg0, VerticalAlignment = Center ]
            }
            TextBlock [ Text = "The console runs only the server image approved when it was installed. After a platform release, reinstall the console to approve the new server image for its environments.",
                        Style = @UiCaption, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,0,0,8), Visibility = $IsConfigured << ToVisibility ]
            Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,0,8),
                     Visibility = $HasDevTrustCommand << ToVisibility ] {
                StackPanel [ Orientation = Vertical ] {
                    TextBlock [ Text = "To trust the development CA on this machine, run this from the repository root (Windows asks you to confirm):",
                                Style = @UiCaption, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,0,0,4) ]
                    DockPanel {
                        Button [ DockPanel.Dock = Right, Variant = Secondary, Command = $CopyTrustCommandCommand, VerticalAlignment = Top, Margin = (12,0,0,0) ] {
                            TextBlock [ Text = "Copy" ]
                        }
                        TextBlock [ Text = $DevTrustCommand, Style = @Code, Foreground = @Fg0, TextWrapping = Wrap ]
                    }
                    TextBlock [ Text = $TrustCopyStatus, Style = @UiCaption, Foreground = @Fg2, Margin = (0,4,0,0),
                                Visibility = $TrustCopyStatus << ToVisibility ]
                }
            }
            Border [ Fill = @StateWarningSoft, Padding = (12,10,12,10), Margin = (0,0,0,8), Visibility = $ErrorText << ToVisibility ] {
                TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap ]
            }
            StackPanel [ Orientation = Horizontal, Margin = (0,0,0,8) ] {
                Button [ Variant = Primary, Command = $RetryCommand, Margin = (0,0,8,0), Visibility = $IsFailed << ToVisibility ] {
                    TextBlock [ Text = "Retry" ]
                }
                Button [ Variant = Secondary, Command = $InstallCommand, Margin = (0,0,8,0), Visibility = $IsDeployed << ToVisibility ] {
                    TextBlock [ Text = "Reinstall console" ]
                }
                Button [ Variant = Secondary, Command = $SetOwnerPasswordCommand, Visibility = $IsConfigured << ToVisibility ] {
                    TextBlock [ Text = "Set Owner password" ]
                }
            }
            Border [ Fill = @StateWarningSoft, Padding = (12,10,12,10), Visibility = $HasOwnerPassword << ToVisibility ] {
                StackPanel [ Orientation = Vertical ] {
                    TextBlock [ Text = "This password is shown once and the old one no longer works. Pass it on over a secure channel; it is gone when you leave this page.",
                                Foreground = @StateWarningInk, TextWrapping = Wrap, Margin = (0,0,0,8) ]
                    TextBlock [ Text = "Within 5 minutes, while the console can reach the platform, every Owner session ends, including any opened with the new password before then. The Owner should sign in again after that.",
                                Foreground = @StateWarningInk, TextWrapping = Wrap, Margin = (0,0,0,8) ]
                    StackPanel [ Orientation = Horizontal, Margin = (0,0,0,4) ] {
                        TextBlock [ Text = "Owner", Style = @UiCaption, Foreground = @Fg2, VerticalAlignment = Center, Margin = (0,0,8,0) ]
                        TextBlock [ Text = $OwnerEmail, Foreground = @Fg0, VerticalAlignment = Center ]
                    }
                    DockPanel {
                        Button [ DockPanel.Dock = Right, Variant = Secondary, Command = $CopyPasswordCommand, Margin = (12,0,0,0) ] {
                            TextBlock [ Text = "Copy" ]
                        }
                        StackPanel [ Orientation = Horizontal, VerticalAlignment = Center ] {
                            TextBlock [ Text = "Password", Style = @UiCaption, Foreground = @Fg2, VerticalAlignment = Center, Margin = (0,0,8,0) ]
                            TextBlock [ Text = $OwnerPassword, Style = @Code, Foreground = @Fg0, VerticalAlignment = Center ]
                        }
                    }
                    TextBlock [ Text = $PasswordCopyStatus, Style = @UiCaption, Foreground = @Fg2, Margin = (0,4,0,0),
                                Visibility = $PasswordCopyStatus << ToVisibility ]
                }
            }
        }
    }

    // The install's steps, one per row.
    ItemsPanelTemplate x:key="AgentInstallStepsPanel" {
        StackPanel [ Orientation = Vertical ]
    }

    // One install step: its label and, once reached, In progress / Done / Failed.
    DataTemplate [ DataType = AgentInstallStepViewModel ] {
        DockPanel [ Margin = (0,2,0,2) ] {
            TextBlock [ DockPanel.Dock = Right, Text = $StatusLabel, Style = @UiCaption, Foreground = @Fg1, Visibility = $IsRunning << ToVisibility ]
            TextBlock [ DockPanel.Dock = Right, Text = $StatusLabel, Style = @UiCaption, Foreground = @StateSuccessInk, Visibility = $IsDone << ToVisibility ]
            TextBlock [ DockPanel.Dock = Right, Text = $StatusLabel, Style = @UiCaption, Foreground = @StateDangerInk, Visibility = $IsFailed << ToVisibility ]
            TextBlock [ Text = $Label, Foreground = @Fg2, Visibility = $IsPending << ToVisibility ]
            TextBlock [ Text = $Label, Foreground = @Fg0, Visibility = $IsReached << ToVisibility ]
        }
    }

    // A reissued agent token, shown once, with the commands that rotate it in.
    DataTemplate [ DataType = AgentTokenRevealPageViewModel ] {
        ScrollViewer [ HorizontalScrollEnabled = false ] {
            StackPanel [ Orientation = Vertical, Margin = (24,20,24,20) ] {
                TextBlock [ Text = "Agent token reissued", Style = @H3, Foreground = @Fg0 ]
                StackPanel [ Orientation = Horizontal, Margin = (0,4,0,16) ] {
                    TextBlock [ Text = "New one-time agent token for hive", Foreground = @Fg2, Margin = (0,0,4,0) ]
                    TextBlock [ Text = $HiveId, Style = @Code, Foreground = @Fg0 ]
                }
                Border [ Fill = @StateWarningSoft, Padding = (12,10,12,10), Margin = (0,0,0,16) ] {
                    TextBlock [ Text = "This token is shown once and the old one no longer works. Copy it now and pass it on over a secure channel. It cannot be shown again.",
                                Foreground = @StateWarningInk, TextWrapping = Wrap ]
                }
                Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,0,8) ] {
                    DockPanel {
                        Button [ DockPanel.Dock = Right, Variant = Secondary, Command = $CopyCommand, Margin = (12,0,0,0) ] {
                            TextBlock [ Text = "Copy" ]
                        }
                        TextBlock [ Text = $Value, Style = @Code, Foreground = @Fg0, VerticalAlignment = Center, TextWrapping = Wrap ]
                    }
                }
                TextBlock [ Text = $CopyStatus, Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,12),
                            Visibility = $CopyStatus << ToVisibility ]

                TextBlock [ Text = "Rotate it in", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,0,2) ]
                TextBlock [ Text = "Run these in the client's cluster: they replace the token Secret and restart the hive's agent (and its tenant-admin pod, if installed).",
                            Style = @UiCaption, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,0,0,6) ]
                ContentControl [ Content = $Install, Margin = (0,0,0,16) ]

                StackPanel [ Orientation = Horizontal, Margin = (0,0,0,16) ] {
                    Checkbox [ IsChecked = $Saved, VerticalAlignment = Center, Margin = (0,0,8,0) ]
                    TextBlock [ Text = "I've saved it", Foreground = @Fg0, VerticalAlignment = Center ]
                }
                Button [ Variant = Primary, Command = $ConfirmSavedCommand, HorizontalAlignment = Left ] {
                    TextBlock [ Text = "Back to the hive" ]
                }
            }
        }
    }
}
