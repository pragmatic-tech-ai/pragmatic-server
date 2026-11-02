// settings.resources.mu - the Settings section's views.
//
// SettingsPageViewModel is presented full-width in the shell's content
// region, matched implicitly by type: the signed-in operator's profile and the
// operator roster. InviteOperatorDialogViewModel renders inside the shell's
// DialogService surface with its own Cancel / Invite buttons; its password
// box masks what is typed.
//
// The roster uses a keyed row template set as the ListBox's ItemTemplate (a
// ListBox resolves implicit templates only for MuralBase items) and the shared
// PortalTable ListBox template.

import SettingsPageViewModel from "./settings-page-view-model.js"
import OperatorRowViewModel from "./settings-page-view-model.js"
import InviteOperatorDialogViewModel from "./invite-operator-dialog-view-model.js"

resources SettingsResources {
    DataTemplate [ DataType = SettingsPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            TextBlock [ DockPanel.Dock = Top, Text = "Settings", Style = @H3, Foreground = @Fg0, Margin = (0,0,0,16) ]

            // Your profile: from the session, always shown.
            TextBlock [ DockPanel.Dock = Top, Text = "Your profile", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,0,6) ]
            Border [ DockPanel.Dock = Top, Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,0,20) ] {
                Grid {
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

            DockPanel [ Visibility = $IsPopulated << ToVisibility ] {
                TextBlock [ DockPanel.Dock = Top, Text = "No operators are listed.", Foreground = @Fg2,
                            Visibility = $HasNoOperators << ToVisibility ]
                Grid [ DockPanel.Dock = Top, Margin = (8,0,8,6), Visibility = $HasOperators << ToVisibility ] {
                    RowDefinitions {
                        RowDefinition [ Height = GridLength.Auto ]
                    }
                    ColumnDefinitions {
                        ColumnDefinition [ Width = GridLength.Star ]
                        ColumnDefinition [ Width = GridLength.Star ]
                        ColumnDefinition [ Width = GridLength.Star ]
                    }
                    TextBlock [ Grid.Column = 0, Text = "Email", Style = @UiCaption, Foreground = @Fg2 ]
                    TextBlock [ Grid.Column = 1, Text = "Role", Style = @UiCaption, Foreground = @Fg2 ]
                    TextBlock [ Grid.Column = 2, Text = "Status", Style = @UiCaption, Foreground = @Fg2 ]
                }
                ListBox [ Template = @PortalTable, HorizontalAlignment = Stretch, ItemsSource = $Operators, ItemTemplate = @OperatorRowTemplate ]
            }
        }
    }

    DataTemplate x:key="OperatorRowTemplate" [ DataType = OperatorRowViewModel ] {
        Grid [ Margin = (4,4,4,4) ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            TextBlock [ Grid.Column = 0, Text = $Email, Style = @Code, Foreground = @Fg0 ]
            TextBlock [ Grid.Column = 1, Text = $RoleLabel, Foreground = @Fg1 ]
            TextBlock [ Grid.Column = 2, Text = $StatusLabel, Foreground = @Fg1 ]
        }
    }

    // Invite operator.
    DataTemplate [ DataType = InviteOperatorDialogViewModel ] {
        StackPanel [ Orientation = Vertical, Margin = (0,4,0,0) ] {
            TextBlock [ Text = "The new operator signs in with this email and the initial password you hand them. Observers can see everything and change nothing.",
                        TextWrapping = Wrap, Foreground = @Fg2, Margin = (0,0,0,12) ]
            TextBlock [ Text = "Email", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ Text = $Email, Placeholder = "e.g. sam@pragmatic.dev", Margin = (0,0,0,12) ]
            TextBlock [ Text = "Initial password", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ Text = $Password, IsPassword = true, Margin = (0,0,0,12) ]
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
