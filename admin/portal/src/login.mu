// login.mu - the operator sign-in, a small application of its own.
//
// PortalBoot imports this only when there is no session (or when the session
// probe fails, with the reason in ErrorText); the shell (app.mu) is imported
// only when there is one. LoginHostService owns the sign-in page view
// model; a successful login reloads the page, which then boots the shell.
// Both boxes edit through real browser inputs (TextBox.UsesNativeInput), so
// password managers (InputPurpose), IME, mobile keyboards and screen readers
// work; Text still binds the real value TwoWay onto the page.
//
// Enter-to-submit: a single-line TextBox leaves Return unhandled, so KeyDown
// bubbles to the form's StackPanel, whose SubmitOnEnter style (a Style is the
// only place `on <Event>` is allowed) invokes SubmitKeyCommand with the key
// args; the page logs in on Return only.

import Pragmatic from "@pragmatic-tech-ai/mural/resources/pragmatic"
import PragmaticDark from "@pragmatic-tech-ai/mural/resources/pragmatic"
import LoginHostService from "./shell/login-host-service.js"

Application [ Theme = Pragmatic, Scheme = PragmaticDark ] {
    .services: {
        LoginHostService
    }

    resources: {
        Style x:key="SubmitOnEnter" [ TargetType = StackPanel ] {
            on KeyDown { InvokeCommand [ Command = $SubmitKeyCommand ] }
        }

        Border x:root [ Fill = @Bg1, DataContext = $service(LoginHostService).Page ] {
            Border [ Fill = @Bg0, Stroke = Pen [ Brush = @Border ], Padding = (24,24,24,24),
                     HorizontalAlignment = Center, VerticalAlignment = Center ] {
                StackPanel [ Orientation = Vertical, Style = @SubmitOnEnter ] {
                    TextBlock [ Text = "Platform Admin", Style = @H3, Foreground = @Fg0 ]
                    TextBlock [ Text = "Operator sign in", Style = @Body, Foreground = @Fg2, Margin = (0,4,0,16) ]

                    TextBlock [ Text = "Email", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                    TextBox [ UsesNativeInput = true, InputPurpose = Email, Text = $Email, Placeholder = "Email", SubmitsOnEnter = true, Margin = (0,0,0,12) ]

                    TextBlock [ Text = "Password", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                    TextBox [ UsesNativeInput = true, InputPurpose = CurrentPassword, Text = $Password, Placeholder = "Password", IsPassword = true, SubmitsOnEnter = true, Margin = (0,0,0,16) ]

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
