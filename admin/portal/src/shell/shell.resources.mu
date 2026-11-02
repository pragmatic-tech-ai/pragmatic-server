// shell.resources.mu - the shell's own views.
//
// The header: EditorShell's HeaderContent is a ContentControl whose Content is
// the PortalSessionService, rendered through this implicit-by-type template.
// It shows who is signed in, their role, the Observer read-only notice
// (collapsed for Operators) and Log out; a failed logout reports here.

import PortalSessionService from "./portal-session-service.js"

resources ShellResources {
    DataTemplate [ DataType = PortalSessionService ] {
        Border [ Fill = @Bg0, Stroke = Pen [ Brush = @Border ], Padding = (16,8,16,8) ] {
            DockPanel {
                Button [ DockPanel.Dock = Right, Variant = Text, Command = $LogoutCommand, Margin = (12,0,0,0) ] {
                    TextBlock [ Text = "Log out" ]
                }
                StackPanel [ DockPanel.Dock = Right, Orientation = Horizontal, VerticalAlignment = Center ] {
                    TextBlock [ Text = $Email, Style = @UiLabel, Foreground = @Fg0, Margin = (0,0,8,0) ]
                    TextBlock [ Text = $RoleLabel, Style = @UiCaption, Foreground = @Fg2 ]
                }
                StackPanel [ Orientation = Horizontal, VerticalAlignment = Center ] {
                    TextBlock [ Text = "Platform Admin", Style = @UiLabel, Foreground = @Fg0, Margin = (0,0,16,0) ]
                    TextBlock [ Text = $ReadOnlyNotice, Style = @UiCaption, Foreground = @StateWarningInk,
                                Margin = (0,0,16,0), Visibility = $ReadOnlyNotice << ToVisibility ]
                    TextBlock [ Text = $LogoutError, Style = @UiCaption, Foreground = @StateDangerInk,
                                Visibility = $LogoutError << ToVisibility ]
                }
            }
        }
    }
}
