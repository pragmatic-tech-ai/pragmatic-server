// users-access.resources.mu - the Users & Access section's views.
//
// UsersAccessPageViewModel, AccountDetailPageViewModel and
// TokenRevealPageViewModel are presented full-width in the shell's content
// region, matched implicitly by type. The page shows its current tab through
// a ContentControl bound to CurrentTab: UsersTabViewModel and
// TokensTabViewModel render here, the Roles & permissions editor from
// SecurityModelResources. The token reveal is a page, not a dialog, so it
// stays until the operator ticks "I've saved it" and presses Done. The
// Create account and Issue token dialogs render inside the shell's
// DialogService surface with their own Cancel / confirm buttons.
//
// Table rows use keyed templates set as the ListBox's ItemTemplate: a ListBox
// resolves implicit-by-type templates only for MuralBase items, and the row
// view-models are Observables.

import UsersAccessPageViewModel from "./users-access-page-view-model.js"
import UsersTabViewModel from "./users-tab-view-model.js"
import AccountRowViewModel from "./users-tab-view-model.js"
import TokensTabViewModel from "./tokens-tab-view-model.js"
import TokenRowViewModel from "./tokens-tab-view-model.js"
import AccountDetailPageViewModel from "./account-detail-page-view-model.js"
import GrantRowViewModel from "./account-detail-page-view-model.js"
import TokenRevealPageViewModel from "./token-reveal-page-view-model.js"
import CreateAccountDialogViewModel from "./create-account-dialog-view-model.js"
import IssueTokenDialogViewModel from "./issue-token-dialog-view-model.js"

resources UsersAccessResources {
    DataTemplate [ DataType = UsersAccessPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            // Page header with the current tab's primary action.
            DockPanel [ DockPanel.Dock = Top, Margin = (0,0,0,16) ] {
                StackPanel [ DockPanel.Dock = Right, Orientation = Horizontal, VerticalAlignment = Top ] {
                    Button [ Variant = Primary, Command = $CreateAccountCommand, Visibility = $IsUsersTab << ToVisibility ] {
                        TextBlock [ Text = "Create account" ]
                    }
                    Button [ Variant = Primary, Command = $IssueTokenCommand, Visibility = $IsTokensTab << ToVisibility ] {
                        TextBlock [ Text = "Issue token" ]
                    }
                }
                StackPanel [ Orientation = Vertical ] {
                    TextBlock [ Text = "Users & Access", Style = @H3, Foreground = @Fg0 ]
                    TextBlock [ Text = "People and service accounts in this tenant, per environment.",
                                Style = @Body, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,4,0,0) ]
                    TextBlock [ Text = $DeniedReason, Style = @UiCaption, Foreground = @StateWarningInk, Margin = (0,4,0,0),
                                Visibility = $DeniedReason << ToVisibility ]
                    TextBlock [ Text = $CommandErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,4,0,0),
                                Visibility = $CommandErrorText << ToVisibility ]
                }
            }

            // Page states: loading, no environments, error, denied.
            TextBlock [ DockPanel.Dock = Top, Text = "Loading environments...", Foreground = @Fg2,
                        Visibility = $IsLoading << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = "No environments available.", Foreground = @Fg2,
                        Visibility = $IsEmpty << ToVisibility ]
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsError << ToVisibility ] {
                TextBlock [ Text = "Could not load the environments.", Foreground = @StateDangerInk ]
                TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap ]
            }
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsDenied << ToVisibility ] {
                TextBlock [ Text = "You don't have access to Users & Access", Style = @UiLabel, Foreground = @Fg0 ]
                TextBlock [ Text = $DeniedPageText, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,4,0,0) ]
            }

            // Populated: the environment picker, the tab strip, the current tab.
            DockPanel [ Visibility = $IsPopulated << ToVisibility ] {
                StackPanel [ DockPanel.Dock = Top, Orientation = Horizontal, Margin = (0,0,0,12) ] {
                    TextBlock [ Text = "Environment", Style = @UiLabel, Foreground = @Fg1, VerticalAlignment = Center, Margin = (0,0,8,0) ]
                    ComboBox [ ItemsSource = $Environments, SelectedItem = $SelectedEnvironment, Placeholder = "Choose environment" ]
                }
                SegmentedButton [ DockPanel.Dock = Top, ItemsSource = $TabLabels, SelectedItem = $SelectedTab, SelectionMode = Single,
                                  HorizontalAlignment = Left, Margin = (0,0,0,16) ]
                ContentControl [ Content = $CurrentTab ]
            }
        }
    }

    // The Users tab: the environment's accounts.
    DataTemplate [ DataType = UsersTabViewModel ] {
        DockPanel {
            TextBlock [ DockPanel.Dock = Top, Text = "Loading accounts...", Foreground = @Fg2,
                        Visibility = $IsLoading << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = "No accounts in this environment yet. Create one for each person who needs access.",
                        Foreground = @Fg2, TextWrapping = Wrap, Visibility = $IsEmpty << ToVisibility ]
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsError << ToVisibility ] {
                TextBlock [ Text = "Could not load the accounts.", Foreground = @StateDangerInk ]
                TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap ]
            }
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsDenied << ToVisibility ] {
                TextBlock [ Text = "You don't have access to these accounts", Style = @UiLabel, Foreground = @Fg0 ]
                TextBlock [ Text = $ErrorText, Foreground = @Fg2, TextWrapping = Wrap ]
            }
            TextBlock [ DockPanel.Dock = Top, Text = $CommandErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap,
                        Margin = (0,0,0,8), Visibility = $CommandErrorText << ToVisibility ]

            ScrollViewer [ HorizontalScrollEnabled = false, Visibility = $IsPopulated << ToVisibility ] {
                StackPanel [ Orientation = Vertical ] {
                    Grid [ Style = @TenantTableColumns ] {
                        ColumnDefinitions {
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                        }
                        TextBlock [ Grid.Column = 0, Text = "Email", Style = @TenantTableLinkHeader ]
                        TextBlock [ Grid.Column = 1, Text = "Roles", Style = @TenantTableHeader ]
                        TextBlock [ Grid.Column = 2, Text = "Status", Style = @TenantTableHeader ]
                    }
                    ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $Rows,
                              ItemTemplate = @AccountRowTemplate ]
                }
            }
        }
    }

    // An accounts-table row; the email opens the account's detail.
    DataTemplate x:key="AccountRowTemplate" [ DataType = AccountRowViewModel ] {
        Grid [ Style = @TenantTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            StackPanel [ Grid.Column = 0, Orientation = Horizontal, VerticalAlignment = Center ] {
                Button [ Variant = Ghost, Command = $OpenCommand, HorizontalAlignment = Left ] {
                    TextBlock [ Text = $Email, Style = @UiLabel ]
                }
                Border [ Fill = @StateInfoSoft, Padding = (6,1,6,1), Margin = (8,0,0,0), VerticalAlignment = Center,
                         Visibility = $IsYou << ToVisibility ] {
                    TextBlock [ Text = "You", Style = @UiCaption, Foreground = @Fg0 ]
                }
            }
            TextBlock [ Grid.Column = 1, Text = $RolesText, Foreground = @Fg1, VerticalAlignment = Center ]
            StackPanel [ Grid.Column = 2, Orientation = Horizontal, VerticalAlignment = Center ] {
                Border [ Fill = @StateSuccessSoft, Padding = (8,2,8,2), Visibility = $IsActive << ToVisibility ] {
                    TextBlock [ Text = $StatusLabel, Style = @UiCaption, Foreground = @StateSuccessInk ]
                }
                Border [ Fill = @Bg2, Padding = (8,2,8,2), Visibility = $IsDisabled << ToVisibility ] {
                    TextBlock [ Text = $StatusLabel, Style = @UiCaption, Foreground = @Fg2 ]
                }
            }
        }
    }

    // The Tokens tab: the environment's issued API tokens.
    DataTemplate [ DataType = TokensTabViewModel ] {
        DockPanel {
            TextBlock [ DockPanel.Dock = Top, Text = "API tokens act as the principal that owns them. A token's value is shown once when issued.",
                        Style = @UiCaption, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,0,0,12) ]
            TextBlock [ DockPanel.Dock = Top, Text = "Loading tokens...", Foreground = @Fg2,
                        Visibility = $IsLoading << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = "No tokens issued in this environment.", Foreground = @Fg2,
                        Visibility = $IsEmpty << ToVisibility ]
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsError << ToVisibility ] {
                TextBlock [ Text = "Could not load the tokens.", Foreground = @StateDangerInk ]
                TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap ]
            }
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsDenied << ToVisibility ] {
                TextBlock [ Text = "You don't have access to these tokens", Style = @UiLabel, Foreground = @Fg0 ]
                TextBlock [ Text = $ErrorText, Foreground = @Fg2, TextWrapping = Wrap ]
            }
            TextBlock [ DockPanel.Dock = Top, Text = $DeniedReason, Style = @UiCaption, Foreground = @StateWarningInk,
                        Margin = (0,0,0,8), Visibility = $DeniedReason << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = $CommandErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap,
                        Margin = (0,0,0,8), Visibility = $CommandErrorText << ToVisibility ]

            ScrollViewer [ HorizontalScrollEnabled = false, Visibility = $IsPopulated << ToVisibility ] {
                StackPanel [ Orientation = Vertical ] {
                    Grid [ Style = @TenantTableColumns ] {
                        ColumnDefinitions {
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                        }
                        TextBlock [ Grid.Column = 0, Text = "Token reference", Style = @TenantTableHeader ]
                        TextBlock [ Grid.Column = 1, Text = "Owner", Style = @TenantTableHeader ]
                        TextBlock [ Grid.Column = 2, Text = "Scopes", Style = @TenantTableHeader ]
                        TextBlock [ Grid.Column = 3, Text = "Expires", Style = @TenantTableHeader ]
                        TextBlock [ Grid.Column = 4, Text = "Status", Style = @TenantTableHeader ]
                        TextBlock [ Grid.Column = 5, Text = "", Style = @TenantTableHeader ]
                    }
                    ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $Rows,
                              ItemTemplate = @TokenRowTemplate ]
                }
            }
        }
    }

    // A tokens-table row with its Revoke.
    DataTemplate x:key="TokenRowTemplate" [ DataType = TokenRowViewModel ] {
        Grid [ Style = @TenantTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            TextBlock [ Grid.Column = 0, Text = $TokenRef, Style = @Code, Foreground = @Fg0, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 1, Text = $Owner, Foreground = @Fg1, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 2, Text = $ScopesText, Foreground = @Fg1, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 3, Text = $ExpiresText, Foreground = @Fg2, VerticalAlignment = Center ]
            StackPanel [ Grid.Column = 4, Orientation = Horizontal, VerticalAlignment = Center ] {
                Border [ Fill = @StateSuccessSoft, Padding = (8,2,8,2), Visibility = $IsActive << ToVisibility ] {
                    TextBlock [ Text = $StatusLabel, Style = @UiCaption, Foreground = @StateSuccessInk ]
                }
                Border [ Fill = @StateWarningSoft, Padding = (8,2,8,2), Visibility = $IsExpired << ToVisibility ] {
                    TextBlock [ Text = $StatusLabel, Style = @UiCaption, Foreground = @StateWarningInk ]
                }
                Border [ Fill = @Bg2, Padding = (8,2,8,2), Visibility = $IsRevoked << ToVisibility ] {
                    TextBlock [ Text = $StatusLabel, Style = @UiCaption, Foreground = @Fg2 ]
                }
            }
            Button [ Grid.Column = 5, Variant = Secondary, Command = $RevokeCommand, HorizontalAlignment = Right, VerticalAlignment = Center ] {
                TextBlock [ Text = "Revoke" ]
            }
        }
    }

    // An account in one environment: status, grants, and its actions.
    DataTemplate [ DataType = AccountDetailPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            // Page header: back, the account, Issue token and Disable.
            DockPanel [ DockPanel.Dock = Top, Margin = (0,0,0,16) ] {
                StackPanel [ DockPanel.Dock = Right, Orientation = Horizontal, VerticalAlignment = Top ] {
                    Button [ Variant = Secondary, Command = $IssueTokenCommand, Margin = (0,0,8,0) ] {
                        TextBlock [ Text = "Issue token" ]
                    }
                    Button [ Variant = Danger, Command = $DisableCommand ] {
                        TextBlock [ Text = "Disable account" ]
                    }
                }
                StackPanel [ Orientation = Vertical ] {
                    Button [ Variant = Ghost, Command = $BackCommand, HorizontalAlignment = Left, Margin = (0,0,0,8) ] {
                        TextBlock [ Text = "Back" ]
                    }
                    StackPanel [ Orientation = Horizontal ] {
                        TextBlock [ Text = $Email, Style = @H3, Foreground = @Fg0 ]
                        Border [ Fill = @StateInfoSoft, Padding = (6,1,6,1), Margin = (8,0,0,0), VerticalAlignment = Center,
                                 Visibility = $IsYou << ToVisibility ] {
                            TextBlock [ Text = "You", Style = @UiCaption, Foreground = @Fg0 ]
                        }
                    }
                    StackPanel [ Orientation = Horizontal, Margin = (0,4,0,0) ] {
                        TextBlock [ Text = "Principal id", Foreground = @Fg2, Margin = (0,0,4,0) ]
                        TextBlock [ Text = $PrincipalId, Style = @Code, Foreground = @Fg1, Margin = (0,0,12,0) ]
                        TextBlock [ Text = "Environment", Foreground = @Fg2, Margin = (0,0,4,0) ]
                        TextBlock [ Text = $Environment, Foreground = @Fg1, Margin = (0,0,12,0) ]
                        TextBlock [ Text = "Status", Foreground = @Fg2, Margin = (0,0,4,0) ]
                        TextBlock [ Text = $StatusLabel, Foreground = @Fg1 ]
                    }
                    TextBlock [ Text = $DeniedReason, Style = @UiCaption, Foreground = @StateWarningInk, Margin = (0,4,0,0),
                                Visibility = $DeniedReason << ToVisibility ]
                    TextBlock [ Text = $CommandErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,4,0,0),
                                Visibility = $CommandErrorText << ToVisibility ]
                }
            }

            TextBlock [ DockPanel.Dock = Top, Text = "Loading the account...", Foreground = @Fg2,
                        Visibility = $IsLoading << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = "This account no longer exists in this environment.", Foreground = @Fg2,
                        Visibility = $IsEmpty << ToVisibility ]
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsError << ToVisibility ] {
                TextBlock [ Text = "Could not load the account.", Foreground = @StateDangerInk ]
                TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap ]
            }
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsDenied << ToVisibility ] {
                TextBlock [ Text = "You don't have access to this account", Style = @UiLabel, Foreground = @Fg0 ]
                TextBlock [ Text = $ErrorText, Foreground = @Fg2, TextWrapping = Wrap ]
            }

            ScrollViewer [ HorizontalScrollEnabled = false, Visibility = $IsPopulated << ToVisibility ] {
                StackPanel [ Orientation = Vertical ] {
                    // Grant role.
                    TextBlock [ Text = "Grant a role", Style = @TenantSectionCaption ]
                    Border [ Style = @TenantPanel ] {
                        StackPanel [ Orientation = Horizontal ] {
                            ComboBox [ ItemsSource = $Roles, SelectedItem = $SelectedRole, Placeholder = "Choose role", Margin = (0,0,8,0) ]
                            Button [ Variant = Primary, Command = $GrantCommand ] {
                                TextBlock [ Text = "Grant" ]
                            }
                        }
                    }

                    // The account's grants.
                    TextBlock [ Text = "Grants", Style = @TenantSectionCaption ]
                    Border [ Style = @TenantPanel ] {
                        StackPanel [ Orientation = Vertical ] {
                            TextBlock [ Text = "No roles granted in this environment.", Foreground = @Fg2,
                                        Visibility = $HasNoGrants << ToVisibility ]
                            StackPanel [ Orientation = Vertical, Visibility = $HasGrants << ToVisibility ] {
                                Grid [ Style = @TenantTableColumns ] {
                                    ColumnDefinitions {
                                        ColumnDefinition [ Width = GridLength.Star ]
                                        ColumnDefinition [ Width = GridLength.Star ]
                                        ColumnDefinition [ Width = GridLength.Star ]
                                    }
                                    TextBlock [ Grid.Column = 0, Text = "Role", Style = @TenantTableHeader ]
                                    TextBlock [ Grid.Column = 1, Text = "Resource path", Style = @TenantTableHeader ]
                                    TextBlock [ Grid.Column = 2, Text = "", Style = @TenantTableHeader ]
                                }
                                ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $Grants,
                                          ItemTemplate = @GrantRowTemplate ]
                            }
                        }
                    }
                }
            }
        }
    }

    // A grant line with its Revoke.
    DataTemplate x:key="GrantRowTemplate" [ DataType = GrantRowViewModel ] {
        Grid [ Style = @TenantTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            TextBlock [ Grid.Column = 0, Text = $Role, Style = @UiLabel, Foreground = @Fg0, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 1, Text = $ResourceText, Style = @Code, Foreground = @Fg1, VerticalAlignment = Center ]
            Button [ Grid.Column = 2, Variant = Secondary, Command = $RevokeCommand, HorizontalAlignment = Right, VerticalAlignment = Center ] {
                TextBlock [ Text = "Revoke" ]
            }
        }
    }

    // A just-issued API token. Shown once; leaving needs "I've saved it".
    DataTemplate [ DataType = TokenRevealPageViewModel ] {
        StackPanel [ Orientation = Vertical, Margin = (24,20,24,20) ] {
            TextBlock [ Text = "API token issued", Style = @H3, Foreground = @Fg0 ]
            StackPanel [ Orientation = Horizontal, Margin = (0,4,0,16) ] {
                TextBlock [ Text = "Acts as", Foreground = @Fg2, Margin = (0,0,4,0) ]
                TextBlock [ Text = $PrincipalId, Foreground = @Fg0, Margin = (0,0,12,0) ]
                TextBlock [ Text = "Environment", Foreground = @Fg2, Margin = (0,0,4,0) ]
                TextBlock [ Text = $Environment, Foreground = @Fg0, Margin = (0,0,12,0) ]
                TextBlock [ Text = "Reference", Foreground = @Fg2, Margin = (0,0,4,0) ]
                TextBlock [ Text = $TokenRef, Style = @Code, Foreground = @Fg0 ]
            }
            Border [ Fill = @StateWarningSoft, Padding = (12,10,12,10), Margin = (0,0,0,16) ] {
                TextBlock [ Text = "Copy it now. It will not be shown again.", Foreground = @StateWarningInk ]
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
                TextBlock [ Text = "Done" ]
            }
        }
    }

    // Create account.
    DataTemplate [ DataType = CreateAccountDialogViewModel ] {
        StackPanel [ Orientation = Vertical, Margin = (0,4,0,0) ] {
            StackPanel [ Orientation = Horizontal, Margin = (0,0,0,12) ] {
                TextBlock [ Text = "Creates a local account in", Foreground = @Fg2, Margin = (0,0,4,0) ]
                TextBlock [ Text = $Environment, Foreground = @Fg0 ]
            }
            TextBlock [ Text = "Email", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ UsesNativeInput = true, InputPurpose = Email, Text = $Email, Placeholder = "person@example.com", Margin = (0,0,0,12) ]
            TextBlock [ Text = "Principal id", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ UsesNativeInput = true, Text = $PrincipalId, Placeholder = "e.g. jane.doe", Margin = (0,0,0,12) ]
            TextBlock [ Text = "Password", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ UsesNativeInput = true, InputPurpose = NewPassword, Text = $Password, IsPassword = true, Margin = (0,0,0,12) ]
            TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,0,0,12),
                        Visibility = $ErrorText << ToVisibility ]
            StackPanel [ Orientation = Horizontal, HorizontalAlignment = Right ] {
                Button [ Variant = Secondary, Command = $CancelCommand, Margin = (0,0,8,0) ] {
                    TextBlock [ Text = "Cancel" ]
                }
                Button [ Variant = Primary, Command = $ConfirmCommand ] {
                    TextBlock [ Text = "Create account" ]
                }
            }
        }
    }

    // Issue token.
    DataTemplate [ DataType = IssueTokenDialogViewModel ] {
        StackPanel [ Orientation = Vertical, Margin = (0,4,0,0) ] {
            TextBlock [ Text = "The token acts as this principal. Its value is shown once, then only referenced by name.",
                        TextWrapping = Wrap, Foreground = @Fg2, Margin = (0,0,0,12) ]
            TextBlock [ Text = "Principal id", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ UsesNativeInput = true, Text = $PrincipalId, Placeholder = "e.g. ci-bot", Margin = (0,0,0,12) ]
            TextBlock [ Text = "Scopes (space- or comma-separated)", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ UsesNativeInput = true, Text = $Scopes, Placeholder = "e.g. read write", Margin = (0,0,0,4) ]
            TextBlock [ Text = $ScopesErrorText, Style = @UiCaption, Foreground = @StateDangerInk, Margin = (0,0,0,4),
                        Visibility = $ScopesErrorText << ToVisibility ]
            TextBlock [ Text = "Expires after", Style = @UiCaption, Foreground = @Fg2, Margin = (0,8,0,4) ]
            ComboBox [ ItemsSource = $Durations, SelectedItem = $SelectedDuration, HorizontalAlignment = Stretch, Margin = (0,0,0,12) ]
            TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,0,0,12),
                        Visibility = $ErrorText << ToVisibility ]
            StackPanel [ Orientation = Horizontal, HorizontalAlignment = Right ] {
                Button [ Variant = Secondary, Command = $CancelCommand, Margin = (0,0,8,0) ] {
                    TextBlock [ Text = "Cancel" ]
                }
                Button [ Variant = Primary, Command = $ConfirmCommand ] {
                    TextBlock [ Text = "Issue token" ]
                }
            }
        }
    }
}
