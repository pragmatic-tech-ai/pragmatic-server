// login.mu - the operator sign-in, a small application of its own.
//
// main.ts imports this only when there is no session; the shell (app.mu) is
// imported only when there is one. LoginHostService owns the sign-in page view
// model; a successful login reloads the page, which then boots the shell.
// The password box masks its glyphs (TextBox.IsPassword); Text still binds
// the real value TwoWay onto the page.

import Pragmatic from "@pragmatic-tech-ai/mural/resources/pragmatic"
import PragmaticLight from "@pragmatic-tech-ai/mural/resources/pragmatic"
import LoginHostService from "./shell/login-host-service.js"

Application [ Theme = Pragmatic, Scheme = PragmaticLight ] {
    .services: {
        LoginHostService
    }

    resources: {
        Border x:root [ Fill = @Bg1, DataContext = $service(LoginHostService).Page ] {
            Border [ Fill = @Bg0, Stroke = Pen [ Brush = @Border ], Padding = (24,24,24,24),
                     HorizontalAlignment = Center, VerticalAlignment = Center ] {
                StackPanel [ Orientation = Vertical ] {
                    TextBlock [ Text = "Platform Admin", Style = @H3, Foreground = @Fg0 ]
                    TextBlock [ Text = "Operator sign in", Style = @Body, Foreground = @Fg2, Margin = (0,4,0,16) ]

                    TextBlock [ Text = "Email", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                    TextBox [ Text = $Email, Placeholder = "Email", Margin = (0,0,0,12) ]

                    TextBlock [ Text = "Password", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                    TextBox [ Text = $Password, Placeholder = "Password", IsPassword = true, Margin = (0,0,0,16) ]

                    Button [ Variant = Filled, Command = $LoginCommand, HorizontalAlignment = Left ] {
                        TextBlock [ Text = "Log in" ]
                    }
                    TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap,
                                Margin = (0,12,0,0), Visibility = $ErrorText << ToVisibility ]
                }
            }
        }
    }
}
