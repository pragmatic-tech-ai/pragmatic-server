// login.mu - the Tenant Admin's sign-in page, a small application of its own.
//
// TenantBoot imports this only when the session probe fails for a reason
// other than "not signed in" (with the reason in ErrorText); with no session
// it sends the browser straight to the tenant's identity provider, and with
// one it imports the shell (app.mu). Signing in is a redirect to the identity
// provider: this page never asks for a password.

import Pragmatic from "@pragmatic-tech-ai/mural/resources/pragmatic"
import PragmaticDark from "@pragmatic-tech-ai/mural/resources/pragmatic"
import LoginHostService from "./shell/login-host-service.js"

Application [ Theme = Pragmatic, Scheme = PragmaticDark ] {
    .services: {
        LoginHostService
    }

    resources: {
        Border x:root [ Fill = @Bg1, DataContext = $service(LoginHostService).Page ] {
            Border [ Fill = @Bg0, Stroke = Pen [ Brush = @Border ], Padding = (24,24,24,24),
                     HorizontalAlignment = Center, VerticalAlignment = Center ] {
                StackPanel [ Orientation = Vertical ] {
                    TextBlock [ Text = "Tenant Admin", Style = @H3, Foreground = @Fg0 ]
                    TextBlock [ Text = "Sign in through your organisation's identity provider.", Style = @Body,
                                Foreground = @Fg2, Margin = (0,4,0,16) ]
                    TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap,
                                Margin = (0,0,0,16), Visibility = $ErrorText << ToVisibility ]
                    StackPanel [ Orientation = Horizontal ] {
                        Button [ Variant = Filled, Command = $SignInCommand, Margin = (0,0,8,0) ] {
                            TextBlock [ Text = "Sign in" ]
                        }
                        Button [ Variant = Secondary, Command = $RetryCommand ] {
                            TextBlock [ Text = "Try again" ]
                        }
                    }
                }
            }
        }
    }
}
