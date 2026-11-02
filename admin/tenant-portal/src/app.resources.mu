// app.resources.mu - the application's own views, beside the sections'.
//
// The header: EditorShell's HeaderContent is a ContentControl whose Content
// is the TenantSessionService, rendered through this implicit-by-type
// template. It carries the fixed identity plate (organisation / tenant /
// hive: this console manages one tenant in one hive, so there is no
// switcher), the session's Activity count (opens the Activity page in
// Overview), who is signed in with their role, and Log out; a failed logout
// reports here. It lives at the composition root because it reaches a
// section service (Overview) the shell itself does not know.

import TenantSessionService from "./shell/tenant-session-service.js"
import OverviewSectionService from "./sections/overview/overview-section-service.js"

resources AppResources {
    DataTemplate [ DataType = TenantSessionService ] {
        Border [ Fill = @Bg0, Stroke = Pen [ Brush = @Border ], Padding = (16,8,16,8) ] {
            DockPanel {
                Button [ DockPanel.Dock = Right, Variant = Text, Command = $LogoutCommand, Margin = (12,0,0,0) ] {
                    TextBlock [ Text = "Log out" ]
                }
                StackPanel [ DockPanel.Dock = Right, Orientation = Horizontal, VerticalAlignment = Center ] {
                    TextBlock [ Text = $Email, Style = @UiLabel, Foreground = @Fg0, Margin = (0,0,8,0) ]
                    TextBlock [ Text = $RoleLabel, Style = @UiCaption, Foreground = @Fg2 ]
                }
                Button [ DockPanel.Dock = Right, Variant = Text, Command = $service(OverviewSectionService).OpenActivityCommand,
                         Margin = (0,0,16,0) ] {
                    TextBlock [ Text = $ActivityCountText ]
                }
                StackPanel [ Orientation = Horizontal, VerticalAlignment = Center ] {
                    TextBlock [ Text = "Tenant Admin", Style = @UiLabel, Foreground = @Fg0, Margin = (0,0,16,0) ]
                    TextBlock [ Text = $OrganisationLabel, Foreground = @Fg2, Visibility = $HasOrganisation << ToVisibility ]
                    TextBlock [ Text = " / ", Foreground = @Fg3, Visibility = $HasOrganisation << ToVisibility ]
                    TextBlock [ Text = $TenantLabel, Style = @UiLabel, Foreground = @Fg0, Margin = (0,0,8,0) ]
                    TextBlock [ Text = $HiveLabel, Style = @Code, Foreground = @Fg2, Margin = (0,0,16,0) ]
                    TextBlock [ Text = $LogoutError, Style = @UiCaption, Foreground = @StateDangerInk,
                                Visibility = $LogoutError << ToVisibility ]
                }
            }
        }
    }
}
