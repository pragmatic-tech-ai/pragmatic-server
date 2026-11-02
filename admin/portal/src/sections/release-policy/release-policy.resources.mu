// release-policy.resources.mu - the Release Policy section's views.
//
// ReleasePolicyPageViewModel is presented full-width in the shell's content
// region, matched implicitly by type: the policy rules (one per tenant and per
// hive), the versions gated for each tenant, each hive's selected target, the
// fleet-wide rollout status (observed) and the adoption ledger. The
// rule editor (PolicyEditDialogViewModel) and Gate a version
// (GateDialogViewModel) render inside the shell's DialogService surface with
// their own buttons.
//
// Tables use keyed row templates set as the ListBox's ItemTemplate (a ListBox
// resolves implicit templates only for MuralBase items) and the shared
// PortalTable ListBox template.

import ReleasePolicyPageViewModel from "./release-policy-page-view-model.js"
import PolicyRuleRowViewModel from "./release-policy-page-view-model.js"
import GatedVersionRowViewModel from "./release-policy-page-view-model.js"
import AdoptionLedgerRowViewModel from "./release-policy-page-view-model.js"
import SelectedTargetRowViewModel from "./release-policy-fleet-rows.js"
import RolloutRowViewModel from "./release-policy-fleet-rows.js"
import PolicyEditDialogViewModel from "./policy-edit-dialog-view-model.js"
import GateDialogViewModel from "./gate-dialog-view-model.js"

resources ReleasePolicyResources {
    DataTemplate [ DataType = ReleasePolicyPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            DockPanel [ DockPanel.Dock = Top, Margin = (0,0,0,16) ] {
                Button [ DockPanel.Dock = Right, Variant = Primary, Command = $GateCommand, VerticalAlignment = Top ] {
                    TextBlock [ Text = "Gate a version" ]
                }
                StackPanel [ Orientation = Vertical ] {
                    TextBlock [ Text = "Release Policy", Style = @H3, Foreground = @Fg0 ]
                    TextBlock [ Text = "Which versions each hive is allowed to adopt, and the record of what each hive did adopt. Rolls run in the hive; outcomes are recorded here.",
                                Style = @Body, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,4,0,0) ]
                    TextBlock [ Text = $DeniedReason, Style = @UiCaption, Foreground = @StateWarningInk, Margin = (0,4,0,0),
                                Visibility = $DeniedReason << ToVisibility ]
                    TextBlock [ Text = $CommandErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,4,0,0),
                                Visibility = $CommandErrorText << ToVisibility ]
                }
            }

            TextBlock [ DockPanel.Dock = Top, Text = "Loading the release policy...", Foreground = @Fg2,
                        Visibility = $IsLoading << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = "No tenants, gated versions or adoptions yet. Rules appear here once a tenant exists.",
                        Foreground = @Fg2, TextWrapping = Wrap, Visibility = $IsEmpty << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = $ErrorText, Foreground = @StateDangerInk,
                        TextWrapping = Wrap, Visibility = $IsError << ToVisibility ]

            ScrollViewer [ HorizontalScrollEnabled = false, Visibility = $IsPopulated << ToVisibility ] {
                StackPanel [ Orientation = Vertical ] {
                    // Policy rules: a tenant's applies to every hive of it; a
                    // hive's narrows it (unset values inherit the tenant's).
                    TextBlock [ Text = "Policy rules", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,0,6) ]
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
                        TextBlock [ Grid.Column = 0, Text = "Applies to", Style = @UiCaption, Foreground = @Fg2 ]
                        TextBlock [ Grid.Column = 1, Text = "Scope", Style = @UiCaption, Foreground = @Fg2 ]
                        TextBlock [ Grid.Column = 2, Text = "Channels", Style = @UiCaption, Foreground = @Fg2 ]
                        TextBlock [ Grid.Column = 3, Text = "Minimum version", Style = @UiCaption, Foreground = @Fg2 ]
                        TextBlock [ Grid.Column = 4, Text = "Hold", Style = @UiCaption, Foreground = @Fg2 ]
                    }
                    ListBox [ Style = @PortalTableList, HorizontalAlignment = Stretch, ItemsSource = $PolicyRows,
                              ItemTemplate = @PolicyRuleRowTemplate, Margin = (0,0,0,20) ]

                    // Gated versions: allowed for a tenant, subject to its rules.
                    TextBlock [ Text = "Gated versions", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,0,6) ]
                    TextBlock [ Text = "No version is gated for any tenant yet.", Foreground = @Fg2, Margin = (0,0,0,20),
                                Visibility = $HasNoGated << ToVisibility ]
                    StackPanel [ Orientation = Vertical, Visibility = $HasGated << ToVisibility ] {
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
                            }
                            TextBlock [ Grid.Column = 0, Text = "Client / tenant", Style = @UiCaption, Foreground = @Fg2 ]
                            TextBlock [ Grid.Column = 1, Text = "Version", Style = @UiCaption, Foreground = @Fg2 ]
                            TextBlock [ Grid.Column = 2, Text = "Gated", Style = @UiCaption, Foreground = @Fg2 ]
                            TextBlock [ Grid.Column = 3, Text = "Adoptable?", Style = @UiCaption, Foreground = @Fg2 ]
                        }
                        ListBox [ Style = @PortalTableList, HorizontalAlignment = Stretch, ItemsSource = $GatedRows,
                                  ItemTemplate = @GatedVersionRowTemplate, Margin = (0,0,0,20) ]
                    }

                    // Selected targets: the version each hive's tenant chose.
                    TextBlock [ Text = "Selected targets", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,0,6) ]
                    TextBlock [ Text = "No hive has a target selected yet.", Foreground = @Fg2, Margin = (0,0,0,20),
                                Visibility = $HasNoTargets << ToVisibility ]
                    StackPanel [ Orientation = Vertical, Visibility = $HasTargets << ToVisibility ] {
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
                            TextBlock [ Grid.Column = 0, Text = "Hive", Style = @UiCaption, Foreground = @Fg2 ]
                            TextBlock [ Grid.Column = 1, Text = "Client / tenant", Style = @UiCaption, Foreground = @Fg2 ]
                            TextBlock [ Grid.Column = 2, Text = "Target version", Style = @UiCaption, Foreground = @Fg2 ]
                            TextBlock [ Grid.Column = 3, Text = "Selected", Style = @UiCaption, Foreground = @Fg2 ]
                        }
                        ListBox [ Style = @PortalTableList, HorizontalAlignment = Stretch, ItemsSource = $TargetRows,
                                  ItemTemplate = @SelectedTargetRowTemplate, Margin = (0,0,0,20) ]
                    }

                    // Rollout status: every hive environment against its target (observed).
                    StackPanel [ Orientation = Horizontal, Margin = (0,0,0,6) ] {
                        TextBlock [ Text = "Rollout status", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,8,0) ]
                        TextBlock [ Text = "Observed - read-only", Style = @UiCaption, Foreground = @Fg2, VerticalAlignment = Center ]
                    }
                    TextBlock [ Text = "No rollout information yet.", Foreground = @Fg2, Margin = (0,0,0,20),
                                Visibility = $HasNoRollouts << ToVisibility ]
                    StackPanel [ Orientation = Vertical, Visibility = $HasRollouts << ToVisibility ] {
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
                            TextBlock [ Grid.Column = 0, Text = "Hive", Style = @UiCaption, Foreground = @Fg2 ]
                            TextBlock [ Grid.Column = 1, Text = "Client / tenant", Style = @UiCaption, Foreground = @Fg2 ]
                            TextBlock [ Grid.Column = 2, Text = "Environment", Style = @UiCaption, Foreground = @Fg2 ]
                            TextBlock [ Grid.Column = 3, Text = "Target", Style = @UiCaption, Foreground = @Fg2 ]
                            TextBlock [ Grid.Column = 4, Text = "Running", Style = @UiCaption, Foreground = @Fg2 ]
                            TextBlock [ Grid.Column = 5, Text = "Status", Style = @UiCaption, Foreground = @Fg2 ]
                        }
                        ListBox [ Style = @PortalTableList, HorizontalAlignment = Stretch, ItemsSource = $RolloutRows,
                                  ItemTemplate = @RolloutRowTemplate, Margin = (0,0,0,20) ]
                    }

                    // The adoption ledger: what each hive did, newest first.
                    TextBlock [ Text = "Adoption ledger", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,0,6) ]
                    TextBlock [ Text = "No adoptions recorded yet. When a tenant adopts a version, the hive reports the outcome here.",
                                Foreground = @Fg2, TextWrapping = Wrap, Visibility = $HasNoLedger << ToVisibility ]
                    StackPanel [ Orientation = Vertical, Visibility = $HasLedger << ToVisibility ] {
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
                            TextBlock [ Grid.Column = 0, Text = "Recorded", Style = @UiCaption, Foreground = @Fg2 ]
                            TextBlock [ Grid.Column = 1, Text = "Hive", Style = @PortalTableLinkHeader ]
                            TextBlock [ Grid.Column = 2, Text = "Outcome", Style = @UiCaption, Foreground = @Fg2 ]
                            TextBlock [ Grid.Column = 3, Text = "Version", Style = @UiCaption, Foreground = @Fg2 ]
                        }
                        ListBox [ Style = @PortalTableList, HorizontalAlignment = Stretch, ItemsSource = $LedgerRows,
                                  ItemTemplate = @AdoptionLedgerRowTemplate ]
                    }
                }
            }
        }
    }

    DataTemplate x:key="PolicyRuleRowTemplate" [ DataType = PolicyRuleRowViewModel ] {
        Grid [ Style = @PortalTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            TextBlock [ Grid.Column = 0, Text = $AppliesToLabel, Style = @UiLabel, Foreground = @Fg0, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 1, Text = $ScopeLabel, Foreground = @Fg2, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 2, Text = $ChannelsLabel, Foreground = @Fg1, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 3, Text = $MinVersionLabel, Foreground = @Fg1, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 4, Text = $HoldLabel, Foreground = @Fg1, TextWrapping = Wrap, VerticalAlignment = Center ]
            Button [ Grid.Column = 5, Variant = Ghost, Command = $EditCommand, HorizontalAlignment = Left ] {
                TextBlock [ Text = "Edit" ]
            }
        }
    }

    DataTemplate x:key="GatedVersionRowTemplate" [ DataType = GatedVersionRowViewModel ] {
        Grid [ Style = @PortalTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            TextBlock [ Grid.Column = 0, Text = $OwnerLabel, Foreground = @Fg0, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 1, Text = $Version, Style = @Code, Foreground = @Fg1, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 2, Text = $GatedLabel, Style = @Code, Foreground = @Fg2, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 3, Text = $BlockedLabel, Foreground = @Fg1, VerticalAlignment = Center ]
            Button [ Grid.Column = 4, Variant = Ghost, Command = $UngateCommand, HorizontalAlignment = Left ] {
                TextBlock [ Text = "Ungate" ]
            }
        }
    }

    DataTemplate x:key="SelectedTargetRowTemplate" [ DataType = SelectedTargetRowViewModel ] {
        Grid [ Style = @PortalTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            TextBlock [ Grid.Column = 0, Text = $HiveLabel, Foreground = @Fg0 ]
            TextBlock [ Grid.Column = 1, Text = $OwnerLabel, Foreground = @Fg1 ]
            TextBlock [ Grid.Column = 2, Text = $TargetVersion, Style = @Code, Foreground = @Fg1 ]
            TextBlock [ Grid.Column = 3, Text = $SelectedLabel, Style = @Code, Foreground = @Fg2 ]
        }
    }

    DataTemplate x:key="RolloutRowTemplate" [ DataType = RolloutRowViewModel ] {
        Grid [ Style = @PortalTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            TextBlock [ Grid.Column = 0, Text = $HiveLabel, Foreground = @Fg0 ]
            TextBlock [ Grid.Column = 1, Text = $OwnerLabel, Foreground = @Fg1 ]
            TextBlock [ Grid.Column = 2, Text = $Environment, Style = @Code, Foreground = @Fg1 ]
            TextBlock [ Grid.Column = 3, Text = $TargetLabel, Style = @Code, Foreground = @Fg1 ]
            TextBlock [ Grid.Column = 4, Text = $RunningLabel, Style = @Code, Foreground = @Fg2, TextWrapping = Wrap ]
            TextBlock [ Grid.Column = 5, Text = $StatusLabel, Foreground = @Fg1 ]
        }
    }

    DataTemplate x:key="AdoptionLedgerRowTemplate" [ DataType = AdoptionLedgerRowViewModel ] {
        Grid [ Style = @PortalTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            TextBlock [ Grid.Column = 0, Text = $WhenLabel, Style = @Code, Foreground = @Fg2, VerticalAlignment = Center ]
            Button [ Grid.Column = 1, Variant = Ghost, Command = $OpenHiveCommand, HorizontalAlignment = Left ] {
                TextBlock [ Text = $HiveLabel ]
            }
            TextBlock [ Grid.Column = 2, Text = $ActionLabel, Foreground = @Fg0, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 3, Text = $Version, Style = @Code, Foreground = @Fg1, VerticalAlignment = Center ]
        }
    }

    // Edit a rule.
    DataTemplate [ DataType = PolicyEditDialogViewModel ] {
        StackPanel [ Orientation = Vertical, Margin = (0,4,0,0) ] {
            TextBlock [ Text = $TargetLabel, Style = @UiLabel, Foreground = @Fg0 ]
            TextBlock [ Text = $ScopeLabel, Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,12) ]
            TextBlock [ Text = "Channels", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            StackPanel [ Orientation = Horizontal, Margin = (0,0,0,4) ] {
                Checkbox [ IsChecked = $Stable, VerticalAlignment = Center, Margin = (0,0,8,0) ]
                TextBlock [ Text = "Stable", Foreground = @Fg0, VerticalAlignment = Center, Margin = (0,0,16,0) ]
                Checkbox [ IsChecked = $EarlyAccess, VerticalAlignment = Center, Margin = (0,0,8,0) ]
                TextBlock [ Text = "Early access", Foreground = @Fg0, VerticalAlignment = Center ]
            }
            TextBlock [ Text = "Leave both unticked for no channel limit.", Style = @UiCaption, Foreground = @Fg2,
                        TextWrapping = Wrap, Margin = (0,0,0,12) ]
            TextBlock [ Text = "Minimum version (blank for none)", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ Text = $MinVersion, Placeholder = "e.g. 4.1.0", Margin = (0,0,0,12) ]
            StackPanel [ Orientation = Horizontal, Margin = (0,0,0,8) ] {
                Checkbox [ IsChecked = $IsHeld, VerticalAlignment = Center, Margin = (0,0,8,0) ]
                TextBlock [ Text = "Hold all adoption (change freeze)", Foreground = @Fg0, VerticalAlignment = Center ]
            }
            StackPanel [ Orientation = Vertical, Visibility = $IsHeld << ToVisibility ] {
                TextBlock [ Text = "Reason for the hold", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                TextBox [ Text = $HoldReason, Margin = (0,0,0,12) ]
            }
            TextBlock [ Text = "Hives receive the updated offers on their next check-in.", Style = @UiCaption,
                        Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,0,0,12) ]
            TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,0,0,12),
                        Visibility = $ErrorText << ToVisibility ]
            StackPanel [ Orientation = Horizontal, HorizontalAlignment = Right ] {
                Button [ Variant = Secondary, Command = $CancelCommand, Margin = (0,0,8,0) ] {
                    TextBlock [ Text = "Cancel" ]
                }
                Button [ Variant = Primary, Command = $ConfirmCommand ] {
                    TextBlock [ Text = "Save policy" ]
                }
            }
        }
    }

    // Gate a version for a tenant.
    DataTemplate [ DataType = GateDialogViewModel ] {
        StackPanel [ Orientation = Vertical, Margin = (0,4,0,0) ] {
            TextBlock [ Text = "Allows the tenant's hives to adopt the version, subject to the tenant's policy rules.",
                        TextWrapping = Wrap, Foreground = @Fg2, Margin = (0,0,0,12) ]
            TextBlock [ Text = "Tenant", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            ComboBox [ ItemsSource = $Tenants, SelectedItem = $SelectedTenant, Placeholder = "Choose tenant",
                       HorizontalAlignment = Stretch, Margin = (0,0,0,12) ]
            TextBlock [ Text = "Version", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            ComboBox [ ItemsSource = $Versions, SelectedItem = $SelectedVersion, Placeholder = "Choose version",
                       HorizontalAlignment = Stretch, Margin = (0,0,0,12) ]
            TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,0,0,12),
                        Visibility = $ErrorText << ToVisibility ]
            StackPanel [ Orientation = Horizontal, HorizontalAlignment = Right ] {
                Button [ Variant = Secondary, Command = $CancelCommand, Margin = (0,0,8,0) ] {
                    TextBlock [ Text = "Cancel" ]
                }
                Button [ Variant = Primary, Command = $ConfirmCommand ] {
                    TextBlock [ Text = "Gate version" ]
                }
            }
        }
    }
}
