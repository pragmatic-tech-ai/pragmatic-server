// tenants.resources.mu - the Tenants section's views.
//
// TenantsPageViewModel (the list), TenantDetailPageViewModel and
// OwnerPasswordRevealPageViewModel are presented full-width in the shell's
// content region, matched implicitly by type. The
// reveal is a page, not a dialog, so it stays until the operator ticks
// "I've saved it" and continues. NewTenantDialogViewModel renders inside the
// shell's DialogService surface with its own Cancel / Create buttons. The
// tenant detail's observed environments render through the shared
// ObservedEnvironmentsViewModel template (shell resources), read-only.
//
// Table rows use keyed templates set as the ListBox's ItemTemplate: a ListBox
// resolves implicit-by-type templates only for MuralBase items, and the row
// view-models are Observables. Tables use the PortalTable ListBox template
// (shell resources) so rows span the table width.

import TenantsPageViewModel from "./tenants-page-view-model.js"
import TenantRowViewModel from "./tenants-page-view-model.js"
import TenantDetailPageViewModel from "./tenant-detail-page-view-model.js"
import OwnerPasswordRevealPageViewModel from "./owner-password-reveal-page-view-model.js"
import NewTenantDialogViewModel from "./new-tenant-dialog-view-model.js"

resources TenantsResources {
    DataTemplate [ DataType = TenantsPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            // Page header with its one primary action.
            DockPanel [ DockPanel.Dock = Top, Margin = (0,0,0,16) ] {
                Button [ DockPanel.Dock = Right, Variant = Primary, Command = $NewCommand, VerticalAlignment = Top ] {
                    TextBlock [ Text = "Create tenant" ]
                }
                StackPanel [ Orientation = Vertical ] {
                    TextBlock [ Text = "Tenants", Style = @H3, Foreground = @Fg0 ]
                    TextBlock [ Text = "Customer workspaces. Each is bound to exactly one hive.",
                                Style = @Body, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,4,0,0) ]
                    TextBlock [ Text = $DeniedReason, Style = @UiCaption, Foreground = @StateWarningInk, Margin = (0,4,0,0),
                                Visibility = $DeniedReason << ToVisibility ]
                    TextBlock [ Text = $CommandErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,4,0,0),
                                Visibility = $CommandErrorText << ToVisibility ]
                }
            }

            // State presentation: loading, empty and error.
            TextBlock [ DockPanel.Dock = Top, Text = "Loading tenants...", Foreground = @Fg2,
                        Visibility = $IsLoading << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = "No tenants yet. Create a tenant for a client; each tenant gets its own hive.",
                        Foreground = @Fg2, Visibility = $IsEmpty << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = $ErrorText, Foreground = @StateDangerInk,
                        TextWrapping = Wrap, Visibility = $IsError << ToVisibility ]

            // Populated: the tenants table. The page scrolls header and rows
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
                        TextBlock [ Grid.Column = 0, Text = "Tenant", Style = @PortalTableLinkHeader ]
                        TextBlock [ Grid.Column = 1, Text = "Client", Style = @PortalTableHeader ]
                        TextBlock [ Grid.Column = 2, Text = "Hive (1:1)", Style = @PortalTableHeader ]
                        TextBlock [ Grid.Column = 3, Text = "Hive connection", Style = @PortalTableHeader ]
                        TextBlock [ Grid.Column = 4, Text = "Environments (observed)", Style = @PortalTableHeader ]
                        TextBlock [ Grid.Column = 5, Text = "Created", Style = @PortalTableHeader ]
                    }
                    ListBox [ Style = @PortalTableList, HorizontalAlignment = Stretch, ItemsSource = $Rows, ItemTemplate = @TenantRowTemplate ]
                }
            }
        }
    }

    // A tenants-table row; the name opens the tenant's detail.
    DataTemplate x:key="TenantRowTemplate" [ DataType = TenantRowViewModel ] {
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
            TextBlock [ Grid.Column = 1, Text = $ClientName, Foreground = @Fg1, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 2, Text = $HiveName, Foreground = @Fg1, VerticalAlignment = Center ]
            StackPanel [ Grid.Column = 3, Orientation = Vertical, VerticalAlignment = Center ] {
                TextBlock [ Text = $ConnectionLabel, Foreground = @Fg1 ]
                TextBlock [ Text = $LastSeenLabel, Style = @UiCaption, Foreground = @Fg2 ]
            }
            TextBlock [ Grid.Column = 4, Text = $EnvCountText, Foreground = @Fg1, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 5, Text = $CreatedLabel, Foreground = @Fg2, VerticalAlignment = Center ]
        }
    }

    DataTemplate [ DataType = TenantDetailPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            // Page header: back, the tenant, and Delete.
            DockPanel [ DockPanel.Dock = Top, Margin = (0,0,0,16) ] {
                Button [ DockPanel.Dock = Right, Variant = Danger, Command = $DeleteCommand, VerticalAlignment = Top ] {
                    TextBlock [ Text = "Delete tenant" ]
                }
                Button [ DockPanel.Dock = Right, Variant = Secondary, Command = $ResetOwnerPasswordCommand, VerticalAlignment = Top, Margin = (0,0,8,0) ] {
                    TextBlock [ Text = "Reset Owner password" ]
                }
                StackPanel [ Orientation = Vertical ] {
                    Button [ Variant = Ghost, Command = $BackCommand, HorizontalAlignment = Left, Margin = (0,0,0,8) ] {
                        TextBlock [ Text = "Back" ]
                    }
                    TextBlock [ Text = $DisplayName, Style = @H3, Foreground = @Fg0 ]
                    StackPanel [ Orientation = Horizontal, Margin = (0,4,0,0) ] {
                        TextBlock [ Text = $Id, Style = @Code, Foreground = @Fg2, Margin = (0,0,12,0) ]
                        TextBlock [ Text = "Tenant of", Foreground = @Fg2, Margin = (0,0,4,0) ]
                        TextBlock [ Text = $ClientName, Foreground = @Fg1, Margin = (0,0,12,0) ]
                        TextBlock [ Text = "Created", Foreground = @Fg2, Margin = (0,0,4,0) ]
                        TextBlock [ Text = $CreatedLabel, Foreground = @Fg1 ]
                    }
                    TextBlock [ Text = $DeniedReason, Style = @UiCaption, Foreground = @StateWarningInk, Margin = (0,4,0,0),
                                Visibility = $DeniedReason << ToVisibility ]
                    TextBlock [ Text = $CommandErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,4,0,0),
                                Visibility = $CommandErrorText << ToVisibility ]
                }
            }

            TextBlock [ DockPanel.Dock = Top, Text = "Loading the tenant...", Foreground = @Fg2,
                        Visibility = $IsLoading << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = $ErrorText, Foreground = @StateDangerInk,
                        TextWrapping = Wrap, Visibility = $IsError << ToVisibility ]

            ScrollViewer [ HorizontalScrollEnabled = false, Visibility = $IsPopulated << ToVisibility ] {
                StackPanel [ Orientation = Vertical ] {
                    // Hive binding: one tenant, one hive.
                    TextBlock [ Text = "Hive binding", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,0,4) ]
                    TextBlock [ Text = "One tenant, one hive. The binding is set when the hive is stood up and cannot be moved.",
                                Style = @UiCaption, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,0,0,6) ]
                    Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,0,16) ] {
                        StackPanel [ Orientation = Vertical ] {
                            TextBlock [ Text = "No hive is bound to this tenant yet.", Foreground = @Fg2,
                                        Visibility = $HasNoHive << ToVisibility ]
                            Grid [ Visibility = $HasHive << ToVisibility ] {
                                ColumnDefinitions {
                                    ColumnDefinition [ Width = GridLength.Star ]
                                    ColumnDefinition [ Width = GridLength.Star ]
                                    ColumnDefinition [ Width = GridLength.Star ]
                                }
                                StackPanel [ Grid.Column = 0, Orientation = Vertical ] {
                                    TextBlock [ Text = "Hive", Style = @UiCaption, Foreground = @Fg2 ]
                                    Button [ Variant = Ghost, Command = $OpenHiveCommand, HorizontalAlignment = Left ] {
                                        TextBlock [ Text = $HiveName, Style = @UiLabel ]
                                    }
                                }
                                StackPanel [ Grid.Column = 1, Orientation = Vertical ] {
                                    TextBlock [ Text = "Connection", Style = @UiCaption, Foreground = @Fg2 ]
                                    TextBlock [ Text = $ConnectionLabel, Foreground = @Fg0 ]
                                    TextBlock [ Text = $LastSeenLabel, Style = @UiCaption, Foreground = @Fg2 ]
                                }
                                StackPanel [ Grid.Column = 2, Orientation = Vertical ] {
                                    TextBlock [ Text = "Cluster", Style = @UiCaption, Foreground = @Fg2 ]
                                    TextBlock [ Text = $ClusterLabel, Foreground = @Fg0 ]
                                }
                            }
                        }
                    }

                    // The environments the hive observes: read-only.
                    ContentControl [ Content = $Observed ]
                }
            }
        }
    }

    // The new Owner's one-time password. Shown once; leaving needs "I've saved it".
    DataTemplate [ DataType = OwnerPasswordRevealPageViewModel ] {
        StackPanel [ Orientation = Vertical, Margin = (24,20,24,20) ] {
            TextBlock [ Text = $Heading, Style = @H3, Foreground = @Fg0 ]
            StackPanel [ Orientation = Horizontal, Margin = (0,4,0,16) ] {
                TextBlock [ Text = "Owner password for", Foreground = @Fg2, Margin = (0,0,4,0) ]
                TextBlock [ Text = $Email, Foreground = @Fg0 ]
            }
            Border [ Fill = @StateWarningSoft, Padding = (12,10,12,10), Margin = (0,0,0,16) ] {
                TextBlock [ Text = "This password is shown once. Copy it now and pass it to the tenant's Owner over a secure channel. It cannot be shown again.",
                            Foreground = @StateWarningInk, TextWrapping = Wrap ]
            }
            Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,0,8) ] {
                DockPanel {
                    Button [ DockPanel.Dock = Right, Variant = Secondary, Command = $CopyCommand, Margin = (12,0,0,0) ] {
                        TextBlock [ Text = "Copy" ]
                    }
                    TextBlock [ Text = $Value, Style = @Code, Foreground = @Fg0, VerticalAlignment = Center ]
                }
            }
            TextBlock [ Text = $CopyStatus, Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,12),
                        Visibility = $CopyStatus << ToVisibility ]
            StackPanel [ Orientation = Horizontal, Margin = (0,0,0,16) ] {
                Checkbox [ IsChecked = $Saved, VerticalAlignment = Center, Margin = (0,0,8,0) ]
                TextBlock [ Text = "I've saved it", Foreground = @Fg0, VerticalAlignment = Center ]
            }
            Button [ Variant = Primary, Command = $ConfirmSavedCommand, HorizontalAlignment = Left ] {
                TextBlock [ Text = $ContinueLabel ]
            }
        }
    }

    // Create tenant.
    DataTemplate [ DataType = NewTenantDialogViewModel ] {
        StackPanel [ Orientation = Vertical, Margin = (0,4,0,0) ] {
            TextBlock [ Text = "A tenant is a customer workspace. It is served by exactly one hive. Its first Owner receives a one-time password.",
                        TextWrapping = Wrap, Foreground = @Fg2, Margin = (0,0,0,12) ]
            TextBlock [ Text = "Client", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            ComboBox [ ItemsSource = $Clients, SelectedItem = $SelectedClient, Placeholder = "Choose client",
                       HorizontalAlignment = Stretch, Margin = (0,0,0,12) ]
            TextBlock [ Text = "Tenant id", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ UsesNativeInput = true, Text = $Id, Placeholder = "Tenant id (lowercase a-z, 0-9, -)", Margin = (0,0,0,4) ]
            TextBlock [ Text = $IdErrorText, Style = @UiCaption, Foreground = @StateDangerInk, Margin = (0,0,0,4),
                        Visibility = $IdErrorText << ToVisibility ]
            TextBlock [ Text = "Display name", Style = @UiCaption, Foreground = @Fg2, Margin = (0,8,0,4) ]
            TextBox [ UsesNativeInput = true, Text = $DisplayName, Placeholder = "e.g. Tailspin Production", Margin = (0,0,0,12) ]
            TextBlock [ Text = "Owner email", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ UsesNativeInput = true, InputPurpose = Email, Text = $OwnerEmail, Placeholder = "owner@example.com", Margin = (0,0,0,12) ]
            TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,0,0,12),
                        Visibility = $ErrorText << ToVisibility ]
            StackPanel [ Orientation = Horizontal, HorizontalAlignment = Right ] {
                Button [ Variant = Secondary, Command = $CancelCommand, Margin = (0,0,8,0) ] {
                    TextBlock [ Text = "Cancel" ]
                }
                Button [ Variant = Primary, Command = $ConfirmCommand ] {
                    TextBlock [ Text = "Create tenant" ]
                }
            }
        }
    }
}
