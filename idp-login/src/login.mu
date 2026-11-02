// login.mu - the IdP sign-in page, a small application of its own.
//
// Served by the IdP at /<tenant>/authorize. Sign in posts the email and
// password as a native form to that same URL (IdpLoginViewModel), so the IdP
// handles them exactly as before; after a rejected sign-in it serves this
// page again with the failed flag, which ErrorText shows. Both boxes edit
// through real browser inputs (UsesNativeInput): IME, password managers
// (InputPurpose sets the autocomplete tokens), mobile keyboards and screen
// readers all work. Text still binds TwoWay onto the page.
//
// Enter-to-submit: a native-input TextBox passes Return on to mural unhandled,
// so KeyDown bubbles to the form's StackPanel, whose SubmitOnEnter style (a Style is the
// only place `on <Event>` is allowed) invokes SubmitKeyCommand with the key
// args; the page signs in on Return only.

import Pragmatic from "@pragmatic-tech-ai/mural/resources/pragmatic"
import PragmaticDark from "@pragmatic-tech-ai/mural/resources/pragmatic"
import LoginHostService from "./login-host-service.js"

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
                    TextBlock [ Text = "Sign in", Style = @H3, Foreground = @Fg0 ]
                    TextBlock [ Text = "Use your organisation account.", Style = @Body, Foreground = @Fg2, Margin = (0,4,0,16) ]

                    TextBlock [ Text = "Email", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                    TextBox [ Text = $Email, Placeholder = "Email", UsesNativeInput = true, InputPurpose = Email, Margin = (0,0,0,12) ]

                    TextBlock [ Text = "Password", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                    TextBox [ Text = $Password, Placeholder = "Password", IsPassword = true, UsesNativeInput = true, InputPurpose = CurrentPassword, Margin = (0,0,0,16) ]

                    Button [ Variant = Filled, Command = $SignInCommand, HorizontalAlignment = Left ] {
                        TextBlock [ Text = "Sign in" ]
                    }
                    TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap,
                                Margin = (0,12,0,0), Visibility = $ErrorText << ToVisibility ]
                }
            }
        }
    }
}
