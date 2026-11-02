// settings.resources.mu - the Settings section's views.
//
// SettingsPageViewModel is presented full-width in the shell's content
// region, matched implicitly by type: the signed-in operator's profile and the
// operator roster (denied, with the reason, for an Observer). A roster row
// opens OperatorDetailPageViewModel; a password reset shows its new password
// once on OperatorPasswordRevealPageViewModel, a page (a dialog would close on
// Escape). InviteOperatorDialogViewModel renders inside the shell's
// DialogService surface with its own Cancel / Invite buttons; its password
// box masks what is typed.
//
// The roster uses a keyed row template set as the ListBox's ItemTemplate (a
// ListBox resolves implicit templates only for MuralBase items) and the shared
// PortalTable ListBox template.

import SettingsPageViewModel from "./settings-page-view-model.js"
import OperatorRowViewModel from "./settings-page-view-model.js"
import InviteOperatorDialogViewModel from "./invite-operator-dialog-view-model.js"
import OperatorDetailPageViewModel from "./operator-detail-page-view-model.js"
import OperatorPasswordRevealPageViewModel from "./operator-password-reveal-page-view-model.js"

resources SettingsResources {
    DataTemplate [ DataType = SettingsPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            TextBlock [ DockPanel.Dock = Top, Text = "Settings", Style = @H3, Foreground = @Fg0, Margin = (0,0,0,16) ]

            // Your profile: from the session, always shown.
            TextBlock [ DockPanel.Dock = Top, Text = "Your profile", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,0,6) ]
            Border [ DockPanel.Dock = Top, Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,0,20) ] {
                // An Auto row: a top-docked Grid would otherwise take the page's height.
                Grid {
                    RowDefinitions {
                        RowDefinition [ Height = GridLength.Auto ]
                    }
                    ColumnDefinitions {
                        ColumnDefinition [ Width = GridLength.Star ]
                        ColumnDefinition [ Width = GridLength.Star ]
                    }
                    StackPanel [ Grid.Column = 0, Orientation = Vertical ] {
                        TextBlock [ Text = "Email", Style = @UiCaption, Foreground = @Fg2 ]
                        TextBlock [ Text = $Email, Style = @Code, Foreground = @Fg0 ]
                    }
                    StackPanel [ Grid.Column = 1, Orientation = Vertical ] {
                        TextBlock [ Text = "Role", Style = @UiCaption, Foreground = @Fg2 ]
                        TextBlock [ Text = $RoleLabel, Foreground = @Fg0 ]
                    }
                }
            }

            // Operators: header with Invite, then the roster's states.
            DockPanel [ DockPanel.Dock = Top, Margin = (0,0,0,8) ] {
                Button [ DockPanel.Dock = Right, Variant = Secondary, Command = $InviteCommand, VerticalAlignment = Top ] {
                    TextBlock [ Text = "Invite operator" ]
                }
                StackPanel [ Orientation = Vertical ] {
                    TextBlock [ Text = "Operators", Style = @UiLabel, Foreground = @Fg1 ]
                    TextBlock [ Text = "Operators can provision, publish, gate and rotate. Observers see everything and change nothing.",
                                Style = @UiCaption, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,2,0,0) ]
                    TextBlock [ Text = $DeniedReason, Style = @UiCaption, Foreground = @StateWarningInk, Margin = (0,4,0,0),
                                Visibility = $DeniedReason << ToVisibility ]
                    TextBlock [ Text = $CommandErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,4,0,0),
                                Visibility = $CommandErrorText << ToVisibility ]
                }
            }

            TextBlock [ DockPanel.Dock = Top, Text = "Loading operators...", Foreground = @Fg2,
                        Visibility = $IsLoading << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = $ErrorText, Foreground = @StateDangerInk,
                        TextWrapping = Wrap, Visibility = $IsError << ToVisibility ]

            // The page scrolls the roster's header and rows together, so both
            // get the same width.
            ScrollViewer [ HorizontalScrollEnabled = false, Visibility = $IsPopulated << ToVisibility ] {
                StackPanel [ Orientation = Vertical ] {
                    // Denied, not hidden: an Observer is told why there is no roster.
                    StackPanel [ Orientation = Vertical, Visibility = $IsRosterDenied << ToVisibility ] {
                        TextBlock [ Text = "You can't see the operator list.", Foreground = @Fg0 ]
                        TextBlock [ Text = $DeniedReason, Style = @UiCaption, Foreground = @StateWarningInk, Margin = (0,2,0,0) ]
                    }
                    TextBlock [ Text = "No operators are listed.", Foreground = @Fg2,
                                Visibility = $HasNoOperators << ToVisibility ]
                    Grid [ Style = @PortalTableColumns, Visibility = $HasOperators << ToVisibility ] {
                        RowDefinitions {
                            RowDefinition [ Height = GridLength.Auto ]
                        }
                        ColumnDefinitions {
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                        }
                        TextBlock [ Grid.Column = 0, Text = "Email", Style = @PortalTableLinkHeader ]
                        TextBlock [ Grid.Column = 1, Text = "Role", Style = @PortalTableHeader ]
                        TextBlock [ Grid.Column = 2, Text = "Status", Style = @PortalTableHeader ]
                    }
                    ListBox [ Style = @PortalTableList, HorizontalAlignment = Stretch, ItemsSource = $Operators, ItemTemplate = @OperatorRowTemplate ]
                }
            }
        }
    }

    DataTemplate x:key="OperatorRowTemplate" [ DataType = OperatorRowViewModel ] {
        Grid [ Style = @PortalTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            Button [ Grid.Column = 0, Variant = Ghost, Command = $OpenCommand, HorizontalAlignment = Left ] {
                TextBlock [ Text = $Email, Style = @UiLabel ]
            }
            TextBlock [ Grid.Column = 1, Text = $RoleLabel, Foreground = @Fg1, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 2, Text = $StatusLabel, Foreground = @Fg1, VerticalAlignment = Center ]
        }
    }

    // One operator: role, account status, sessions and password.
    DataTemplate [ DataType = OperatorDetailPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Margin = (0,0,0,16) ] {
                Button [ Variant = Ghost, Command = $BackCommand, HorizontalAlignment = Left, Margin = (0,0,0,8) ] {
                    TextBlock [ Text = "Back" ]
                }
                TextBlock [ Text = $Email, Style = @H3, Foreground = @Fg0 ]
                StackPanel [ Orientation = Horizontal, Margin = (0,4,0,0) ] {
                    TextBlock [ Text = $RoleLabel, Foreground = @Fg1, Margin = (0,0,12,0) ]
                    TextBlock [ Text = $StatusLabel, Foreground = @Fg1 ]
                }
                TextBlock [ Text = $DeniedReason, Style = @UiCaption, Foreground = @StateWarningInk, Margin = (0,4,0,0),
                            Visibility = $DeniedReason << ToVisibility ]
                TextBlock [ Text = $CommandErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,4,0,0),
                            Visibility = $CommandErrorText << ToVisibility ]
            }

            TextBlock [ DockPanel.Dock = Top, Text = "Loading the operator...", Foreground = @Fg2,
                        Visibility = $IsLoading << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = $ErrorText, Foreground = @StateDangerInk,
                        TextWrapping = Wrap, Visibility = $IsError << ToVisibility ]

            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsPopulated << ToVisibility ] {
                // Role.
                TextBlock [ Text = "Role", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,0,6) ]
                Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,0,16) ] {
                    DockPanel {
                        Button [ DockPanel.Dock = Right, Variant = Secondary, Command = $ChangeRoleCommand, Margin = (12,0,0,0) ] {
                            TextBlock [ Text = "Change role" ]
                        }
                        ComboBox [ ItemsSource = $Roles, SelectedItem = $SelectedRole, HorizontalAlignment = Stretch ]
                    }
                }

                // Account.
                TextBlock [ Text = "Account", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,0,6) ]
                Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10) ] {
                    StackPanel [ Orientation = Vertical ] {
                        DockPanel [ Margin = (0,0,0,10) ] {
                            Button [ DockPanel.Dock = Right, Variant = Secondary, Command = $ToggleDisabledCommand, Margin = (12,0,0,0) ] {
                                TextBlock [ Text = $ToggleDisabledLabel ]
                            }
                            TextBlock [ Text = "A disabled operator cannot sign in.", Foreground = @Fg2, TextWrapping = Wrap, VerticalAlignment = Center ]
                        }
                        DockPanel [ Margin = (0,0,0,10) ] {
                            Button [ DockPanel.Dock = Right, Variant = Danger, Command = $RevokeSessionsCommand, Margin = (12,0,0,0) ] {
                                TextBlock [ Text = "Revoke sessions" ]
                            }
                            TextBlock [ Text = "Signs the operator out everywhere.", Foreground = @Fg2, TextWrapping = Wrap, VerticalAlignment = Center ]
                        }
                        DockPanel {
                            Button [ DockPanel.Dock = Right, Variant = Danger, Command = $ResetPasswordCommand, Margin = (12,0,0,0) ] {
                                TextBlock [ Text = "Reset password" ]
                            }
                            TextBlock [ Text = "Issues a new password, shown to you once.", Foreground = @Fg2, TextWrapping = Wrap, VerticalAlignment = Center ]
                        }
                    }
                }
            }
        }
    }

    // A reset password. Shown once; leaving needs "I've saved it".
    DataTemplate [ DataType = OperatorPasswordRevealPageViewModel ] {
        StackPanel [ Orientation = Vertical, Margin = (24,20,24,20) ] {
            TextBlock [ Text = "Password reset", Style = @H3, Foreground = @Fg0 ]
            StackPanel [ Orientation = Horizontal, Margin = (0,4,0,16) ] {
                TextBlock [ Text = "New password for", Foreground = @Fg2, Margin = (0,0,4,0) ]
                TextBlock [ Text = $Email, Foreground = @Fg0 ]
            }
            Border [ Fill = @StateWarningSoft, Padding = (12,10,12,10), Margin = (0,0,0,16) ] {
                TextBlock [ Text = "This password is shown once. Copy it now and hand it to the operator over a secure channel. It cannot be shown again.",
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
                TextBlock [ Text = "Back to the operator" ]
            }
        }
    }

    // Invite operator.
    DataTemplate [ DataType = InviteOperatorDialogViewModel ] {
        StackPanel [ Orientation = Vertical, Margin = (0,4,0,0) ] {
            TextBlock [ Text = "The new operator signs in with this email and the initial password you hand them. Observers can see everything and change nothing.",
                        TextWrapping = Wrap, Foreground = @Fg2, Margin = (0,0,0,12) ]
            TextBlock [ Text = "Email", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ UsesNativeInput = true, InputPurpose = Email, Text = $Email, Placeholder = "e.g. sam@pragmatic.dev", Margin = (0,0,0,12) ]
            TextBlock [ Text = "Initial password", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ UsesNativeInput = true, InputPurpose = NewPassword, Text = $Password, IsPassword = true, Margin = (0,0,0,12) ]
            TextBlock [ Text = "Role", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            ComboBox [ ItemsSource = $Roles, SelectedItem = $SelectedRole, HorizontalAlignment = Stretch, Margin = (0,0,0,12) ]
            TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,0,0,12),
                        Visibility = $ErrorText << ToVisibility ]
            StackPanel [ Orientation = Horizontal, HorizontalAlignment = Right ] {
                Button [ Variant = Secondary, Command = $CancelCommand, Margin = (0,0,8,0) ] {
                    TextBlock [ Text = "Cancel" ]
                }
                Button [ Variant = Primary, Command = $ConfirmCommand ] {
                    TextBlock [ Text = "Invite operator" ]
                }
            }
        }
    }
}
