// clients.resources.mu - the Clients section's views.
//
// ClientsPageViewModel (the list) and ClientDetailPageViewModel are presented
// full-width in the shell's content region; their templates are matched
// implicitly by type. NewClientDialogViewModel renders
// inside the shell's DialogService surface, with its own Cancel / Create
// buttons (a DialogAction can't follow validation). Mutating buttons bind
// commands that are disabled for an Observer, and the page shows why.
//
// Table rows use keyed templates set as the ListBox's ItemTemplate: a ListBox
// resolves implicit-by-type templates only for MuralBase items, and the row
// view-models are Observables. Tables use the PortalTable ListBox template
// (shell resources) so rows span the table width.

import ClientsPageViewModel from "./clients-page-view-model.js"
import ClientRowViewModel from "./clients-page-view-model.js"
import ClientDetailPageViewModel from "./client-detail-page-view-model.js"
import ClientTenantRowViewModel from "./client-detail-page-view-model.js"
import NewClientDialogViewModel from "./new-client-dialog-view-model.js"

resources ClientsResources {
    DataTemplate [ DataType = ClientsPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            // Page header with its one primary action.
            DockPanel [ DockPanel.Dock = Top, Margin = (0,0,0,16) ] {
                Button [ DockPanel.Dock = Right, Variant = Primary, Command = $NewCommand, VerticalAlignment = Top ] {
                    TextBlock [ Text = "Create client" ]
                }
                StackPanel [ Orientation = Vertical ] {
                    TextBlock [ Text = "Clients", Style = @H3, Foreground = @Fg0 ]
                    TextBlock [ Text = "Contracting organisations. Each has one or more tenants; each tenant runs in exactly one hive.",
                                Style = @Body, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,4,0,0) ]
                    TextBlock [ Text = $DeniedReason, Style = @UiCaption, Foreground = @StateWarningInk, Margin = (0,4,0,0),
                                Visibility = $DeniedReason << ToVisibility ]
                    TextBlock [ Text = $CommandErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,4,0,0),
                                Visibility = $CommandErrorText << ToVisibility ]
                }
            }

            // State presentation: loading, empty and error.
            TextBlock [ DockPanel.Dock = Top, Text = "Loading clients...", Foreground = @Fg2,
                        Visibility = $IsLoading << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = "No clients yet. Create the first client to start onboarding.",
                        Foreground = @Fg2, Visibility = $IsEmpty << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = $ErrorText, Foreground = @StateDangerInk,
                        TextWrapping = Wrap, Visibility = $IsError << ToVisibility ]

            // Populated: the clients table.
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
                    TextBlock [ Grid.Column = 0, Text = "Client", Style = @UiCaption, Foreground = @Fg2 ]
                    TextBlock [ Grid.Column = 1, Text = "Subscription", Style = @UiCaption, Foreground = @Fg2 ]
                    TextBlock [ Grid.Column = 2, Text = "Tenants", Style = @UiCaption, Foreground = @Fg2 ]
                    TextBlock [ Grid.Column = 3, Text = "Hives", Style = @UiCaption, Foreground = @Fg2 ]
                    TextBlock [ Grid.Column = 4, Text = "Connection", Style = @UiCaption, Foreground = @Fg2 ]
                    TextBlock [ Grid.Column = 5, Text = "Client since", Style = @UiCaption, Foreground = @Fg2 ]
                }
                ListBox [ Template = @PortalTable, HorizontalAlignment = Stretch, ItemsSource = $Rows, ItemTemplate = @ClientRowTemplate ]
            }
        }
    }

    // A clients-table row; the name opens the client's detail.
    DataTemplate x:key="ClientRowTemplate" [ DataType = ClientRowViewModel ] {
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
            TextBlock [ Grid.Column = 1, Text = $SubscriptionLabel, Foreground = @Fg1, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 2, Text = $TenantCountText, Foreground = @Fg1, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 3, Text = $HiveCountText, Foreground = @Fg1, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 4, Text = $ConnectionSummary, Foreground = @Fg1, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 5, Text = $ClientSinceLabel, Foreground = @Fg2, VerticalAlignment = Center ]
        }
    }

    DataTemplate [ DataType = ClientDetailPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            // Page header: back, the client, and Delete.
            DockPanel [ DockPanel.Dock = Top, Margin = (0,0,0,16) ] {
                Button [ DockPanel.Dock = Right, Variant = Danger, Command = $DeleteCommand, VerticalAlignment = Top ] {
                    TextBlock [ Text = "Delete client" ]
                }
                StackPanel [ Orientation = Vertical ] {
                    Button [ Variant = Ghost, Command = $BackCommand, HorizontalAlignment = Left, Margin = (0,0,0,8) ] {
                        TextBlock [ Text = "Back to clients" ]
                    }
                    TextBlock [ Text = $DisplayName, Style = @H3, Foreground = @Fg0 ]
                    TextBlock [ Text = $Id, Style = @Code, Foreground = @Fg2, Margin = (0,4,0,0) ]
                    TextBlock [ Text = $DeniedReason, Style = @UiCaption, Foreground = @StateWarningInk, Margin = (0,4,0,0),
                                Visibility = $DeniedReason << ToVisibility ]
                    TextBlock [ Text = $CommandErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,4,0,0),
                                Visibility = $CommandErrorText << ToVisibility ]
                }
            }

            TextBlock [ DockPanel.Dock = Top, Text = "Loading the client...", Foreground = @Fg2,
                        Visibility = $IsLoading << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = $ErrorText, Foreground = @StateDangerInk,
                        TextWrapping = Wrap, Visibility = $IsError << ToVisibility ]

            ScrollViewer [ HorizontalScrollEnabled = false, Visibility = $IsPopulated << ToVisibility ] {
                StackPanel [ Orientation = Vertical ] {
                    // Profile.
                    Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,0,16) ] {
                        Grid {
                            ColumnDefinitions {
                                ColumnDefinition [ Width = GridLength.Star ]
                                ColumnDefinition [ Width = GridLength.Star ]
                                ColumnDefinition [ Width = GridLength.Star ]
                            }
                            StackPanel [ Grid.Column = 0, Orientation = Vertical ] {
                                TextBlock [ Text = "Client id", Style = @UiCaption, Foreground = @Fg2 ]
                                TextBlock [ Text = $Id, Style = @Code, Foreground = @Fg0 ]
                            }
                            StackPanel [ Grid.Column = 1, Orientation = Vertical ] {
                                TextBlock [ Text = "Subscription", Style = @UiCaption, Foreground = @Fg2 ]
                                TextBlock [ Text = $SubscriptionLabel, Foreground = @Fg0 ]
                            }
                            StackPanel [ Grid.Column = 2, Orientation = Vertical ] {
                                TextBlock [ Text = "Client since", Style = @UiCaption, Foreground = @Fg2 ]
                                TextBlock [ Text = $ClientSinceLabel, Foreground = @Fg0 ]
                            }
                        }
                    }

                    // Tenants and their hives.
                    TextBlock [ Text = "Tenants and hives", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,0,6) ]
                    TextBlock [ Text = "No tenants yet. Create one in Tenants.", Foreground = @Fg2,
                                Visibility = $HasNoTenants << ToVisibility ]
                    StackPanel [ Orientation = Vertical, Visibility = $HasTenants << ToVisibility ] {
                        Grid [ Margin = (8,0,8,6) ] {
                            ColumnDefinitions {
                                ColumnDefinition [ Width = GridLength.Star ]
                                ColumnDefinition [ Width = GridLength.Star ]
                                ColumnDefinition [ Width = GridLength.Star ]
                                ColumnDefinition [ Width = GridLength.Star ]
                                ColumnDefinition [ Width = GridLength.Star ]
                            }
                            TextBlock [ Grid.Column = 0, Text = "Tenant", Style = @UiCaption, Foreground = @Fg2 ]
                            TextBlock [ Grid.Column = 1, Text = "Hive", Style = @UiCaption, Foreground = @Fg2 ]
                            TextBlock [ Grid.Column = 2, Text = "Connection", Style = @UiCaption, Foreground = @Fg2 ]
                            TextBlock [ Grid.Column = 3, Text = "Last check-in", Style = @UiCaption, Foreground = @Fg2 ]
                            TextBlock [ Grid.Column = 4, Text = "Environments (observed)", Style = @UiCaption, Foreground = @Fg2 ]
                        }
                        ListBox [ Template = @PortalTable, HorizontalAlignment = Stretch, ItemsSource = $Tenants, ItemTemplate = @ClientTenantRowTemplate ]
                    }
                }
            }
        }
    }

    DataTemplate x:key="ClientTenantRowTemplate" [ DataType = ClientTenantRowViewModel ] {
        Grid [ Margin = (4,4,4,4) ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            StackPanel [ Grid.Column = 0, Orientation = Vertical ] {
                TextBlock [ Text = $TenantName, Style = @UiLabel, Foreground = @Fg0 ]
                TextBlock [ Text = $TenantId, Style = @UiCaption, Foreground = @Fg2 ]
            }
            TextBlock [ Grid.Column = 1, Text = $HiveName, Foreground = @Fg1 ]
            TextBlock [ Grid.Column = 2, Text = $ConnectionLabel, Foreground = @Fg1 ]
            TextBlock [ Grid.Column = 3, Text = $LastSeenLabel, Foreground = @Fg2 ]
            TextBlock [ Grid.Column = 4, Text = $EnvCountText, Foreground = @Fg2 ]
        }
    }

    // Create client.
    DataTemplate [ DataType = NewClientDialogViewModel ] {
        StackPanel [ Orientation = Vertical, Margin = (0,4,0,0) ] {
            TextBlock [ Text = "A client is the contracting organisation. Tenants and hives are added after.",
                        TextWrapping = Wrap, Foreground = @Fg2, Margin = (0,0,0,12) ]
            TextBlock [ Text = "Client id", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ Text = $Id, Placeholder = "e.g. tailspin", Margin = (0,0,0,12) ]
            TextBlock [ Text = "Display name", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ Text = $DisplayName, Placeholder = "e.g. Tailspin Holdings", Margin = (0,0,0,12) ]
            TextBlock [ Text = "Subscription reference (optional)", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ Text = $SubscriptionRef, Placeholder = "e.g. MSA-2026-014", Margin = (0,0,0,12) ]
            TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,0,0,12),
                        Visibility = $ErrorText << ToVisibility ]
            StackPanel [ Orientation = Horizontal, HorizontalAlignment = Right ] {
                Button [ Variant = Secondary, Command = $CancelCommand, Margin = (0,0,8,0) ] {
                    TextBlock [ Text = "Cancel" ]
                }
                Button [ Variant = Primary, Command = $ConfirmCommand ] {
                    TextBlock [ Text = "Create client" ]
                }
            }
        }
    }
}
