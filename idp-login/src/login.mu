// login.mu - the realm sign-in page, a small application of its own.
//
// Served by the realm sign-in service at <issuer>/protocol/openid-connect/auth.
// IdpLoginViewModel loads what the realm offers (<issuer>/login/config) and
// signs in with a JSON post to <issuer>/login; the page navigates to the
// redirect it answers. The page shows, by what the realm enables:
// - one button per upstream source (Google, Microsoft, OIDC, Pragmatic),
//   each navigating to the source's broker login;
// - Continue with Google through Identity Platform;
// - the email form: sign in, and for Identity Platform also Create an account
//   (sign-up mode) and Forgot password (reset mode);
// - an error line, a notice line, and Resend verification email after an
//   unverified-email refusal.
// The boxes edit through real browser inputs (UsesNativeInput): IME, password
// managers (InputPurpose sets the autocomplete tokens), mobile keyboards and
// screen readers all work. Text still binds TwoWay onto the page.
//
// Enter-to-submit: a native-input TextBox passes Return on to mural unhandled,
// so KeyDown bubbles to the form's StackPanel, whose SubmitOnEnter style (a Style is the
// only place `on <Event>` is allowed) invokes SubmitKeyCommand with the key
// args; the page submits the current form on Return only.

import Pragmatic from "@pragmatic-tech-ai/mural/resources/pragmatic"
import PragmaticDark from "@pragmatic-tech-ai/mural/resources/pragmatic"
import LoginHostService from "./login-host-service.js"
import LoginSourceViewModel from "./login-source-view-model.js"

Application [ Theme = Pragmatic, Scheme = PragmaticDark ] {
    .services: {
        LoginHostService
    }

    resources: {
        Style x:key="SubmitOnEnter" [ TargetType = StackPanel ] {
            on KeyDown { InvokeCommand [ Command = $SubmitKeyCommand ] }
        }

        // The upstream source buttons stack vertically.
        ItemsPanelTemplate x:key="SourcesPanel" {
            StackPanel [ Orientation = Vertical ]
        }

        // One upstream source's button.
        DataTemplate x:key="SourceButtonTemplate" [ DataType = LoginSourceViewModel ] {
            Button [ Variant = Secondary, Command = $SignInCommand, HorizontalAlignment = Stretch, Margin = (0,0,0,8) ] {
                TextBlock [ Text = $Label ]
            }
        }

        Border x:root [ Fill = @Bg1, DataContext = $service(LoginHostService).Page ] {
            Border [ Fill = @Bg0, Stroke = Pen [ Brush = @Border ], Padding = (24,24,24,24),
                     HorizontalAlignment = Center, VerticalAlignment = Center ] {
                StackPanel [ Orientation = Vertical, Style = @SubmitOnEnter ] {
                    TextBlock [ Text = $Title, Style = @H3, Foreground = @Fg0 ]
                    TextBlock [ Text = $DisplayName, Style = @UiCaption, Foreground = @Fg2, Margin = (0,2,0,0),
                                Visibility = $DisplayName << ToVisibility ]
                    TextBlock [ Text = $Subtitle, Style = @Body, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,4,0,16) ]

                    TextBlock [ Text = "Loading...", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,12),
                                Visibility = $IsLoading << ToVisibility ]

                    ItemsControl [ ItemsSource = $Sources, ItemTemplate = @SourceButtonTemplate, ItemsPanel = @SourcesPanel, Visibility = $ShowsSources << ToVisibility ]

                    Button [ Variant = Secondary, Command = $GoogleCommand, HorizontalAlignment = Stretch, Margin = (0,0,0,8),
                             Visibility = $ShowsGoogle << ToVisibility ] {
                        TextBlock [ Text = "Continue with Google" ]
                    }

                    TextBlock [ Text = "or", Style = @UiCaption, Foreground = @Fg2, HorizontalAlignment = Center, Margin = (0,4,0,12),
                                Visibility = $ShowsDivider << ToVisibility ]

                    StackPanel [ Orientation = Vertical, Visibility = $ShowsPasswordForm << ToVisibility ] {
                        TextBlock [ Text = "Email", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                        TextBox [ Text = $Email, Placeholder = "Email", UsesNativeInput = true, InputPurpose = Email, Margin = (0,0,0,12) ]

                        StackPanel [ Orientation = Vertical, Visibility = $ShowsCurrentPassword << ToVisibility ] {
                            TextBlock [ Text = "Password", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                            TextBox [ Text = $Password, Placeholder = "Password", IsPassword = true, UsesNativeInput = true,
                                      InputPurpose = CurrentPassword, Margin = (0,0,0,16) ]
                        }

                        StackPanel [ Orientation = Vertical, Visibility = $ShowsNewPassword << ToVisibility ] {
                            TextBlock [ Text = "Password", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                            TextBox [ Text = $Password, Placeholder = "New password", IsPassword = true, UsesNativeInput = true,
                                      InputPurpose = NewPassword, Margin = (0,0,0,12) ]
                            TextBlock [ Text = "Confirm password", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                            TextBox [ Text = $ConfirmPassword, Placeholder = "Confirm password", IsPassword = true, UsesNativeInput = true,
                                      InputPurpose = NewPassword, Margin = (0,0,0,16) ]
                        }

                        Button [ Variant = Filled, Command = $SignInCommand, HorizontalAlignment = Left,
                                 Visibility = $ShowsSignInButton << ToVisibility ] {
                            TextBlock [ Text = "Sign in" ]
                        }
                        Button [ Variant = Filled, Command = $SignUpCommand, HorizontalAlignment = Left,
                                 Visibility = $ShowsSignUpButton << ToVisibility ] {
                            TextBlock [ Text = "Create account" ]
                        }
                        Button [ Variant = Filled, Command = $SendResetCommand, HorizontalAlignment = Left,
                                 Visibility = $ShowsResetButton << ToVisibility ] {
                            TextBlock [ Text = "Send reset link" ]
                        }
                    }

                    StackPanel [ Orientation = Horizontal, Margin = (0,12,0,0) ] {
                        Button [ Variant = Ghost, Command = $ShowForgotCommand, Margin = (0,0,8,0),
                                 Visibility = $ShowsForgotLink << ToVisibility ] {
                            TextBlock [ Text = "Forgot password?" ]
                        }
                        Button [ Variant = Ghost, Command = $ShowSignUpCommand,
                                 Visibility = $ShowsCreateAccountLink << ToVisibility ] {
                            TextBlock [ Text = "Create an account" ]
                        }
                        Button [ Variant = Ghost, Command = $ShowSignInCommand,
                                 Visibility = $ShowsBackToSignIn << ToVisibility ] {
                            TextBlock [ Text = "Back to sign in" ]
                        }
                    }

                    TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap,
                                Margin = (0,12,0,0), Visibility = $ErrorText << ToVisibility ]
                    TextBlock [ Text = $NoticeText, Foreground = @Fg1, TextWrapping = Wrap,
                                Margin = (0,12,0,0), Visibility = $NoticeText << ToVisibility ]
                    Button [ Variant = Secondary, Command = $ResendVerificationCommand, HorizontalAlignment = Left, Margin = (0,8,0,0),
                             Visibility = $ShowsResend << ToVisibility ] {
                        TextBlock [ Text = "Resend verification email" ]
                    }
                }
            }
        }
    }
}
