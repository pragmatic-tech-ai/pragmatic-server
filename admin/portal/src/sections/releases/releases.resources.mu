// releases.resources.mu - the Registry & Releases section's views.
//
// ReleasesPageViewModel (the list) and ReleaseDetailPageViewModel are
// presented full-width in the shell's content region, matched implicitly by
// type. Where a version runs is observed (reported by hives), read-only.
// PublishDialogViewModel renders inside the shell's DialogService surface with
// its own Cancel / Publish buttons; Withdraw uses the shared name-to-confirm
// dialog (shell resources) with a reason.
//
// The releases table uses a keyed row template set as the ListBox's
// ItemTemplate (a ListBox resolves implicit templates only for MuralBase
// items) and the shared PortalTable ListBox template.

import ReleasesPageViewModel from "./releases-page-view-model.js"
import ReleaseRowViewModel from "./releases-page-view-model.js"
import ReleaseDetailPageViewModel from "./release-detail-page-view-model.js"
import ReleaseAdoptionRowViewModel from "./release-detail-page-view-model.js"
import PublishDialogViewModel from "./publish-dialog-view-model.js"

resources ReleasesResources {
    DataTemplate [ DataType = ReleasesPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            DockPanel [ DockPanel.Dock = Top, Margin = (0,0,0,16) ] {
                Button [ DockPanel.Dock = Right, Variant = Primary, Command = $PublishCommand, VerticalAlignment = Top ] {
                    TextBlock [ Text = "Publish a version" ]
                }
                StackPanel [ Orientation = Vertical ] {
                    TextBlock [ Text = "Registry & Releases", Style = @H3, Foreground = @Fg0 ]
                    TextBlock [ Text = "Signed application images. Hives are offered these; tenants choose when to adopt.",
                                Style = @Body, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,4,0,0) ]
                    TextBlock [ Text = $DeniedReason, Style = @UiCaption, Foreground = @StateWarningInk, Margin = (0,4,0,0),
                                Visibility = $DeniedReason << ToVisibility ]
                    TextBlock [ Text = $CommandErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,4,0,0),
                                Visibility = $CommandErrorText << ToVisibility ]
                }
            }

            TextBlock [ DockPanel.Dock = Top, Text = "Loading versions...", Foreground = @Fg2,
                        Visibility = $IsLoading << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = "No versions published yet. Publish a version to sign it and offer it to hives. Nothing is pushed: tenants adopt when they choose.",
                        Foreground = @Fg2, TextWrapping = Wrap, Visibility = $IsEmpty << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = $ErrorText, Foreground = @StateDangerInk,
                        TextWrapping = Wrap, Visibility = $IsError << ToVisibility ]

            // The page scrolls header and rows together, so both get the
            // same width.
            ScrollViewer [ HorizontalScrollEnabled = false, Visibility = $IsPopulated << ToVisibility ] {
                StackPanel [ Orientation = Vertical ] {
                    Grid [ Style = @PortalTableColumns ] {
                        RowDefinitions {
                            RowDefinition [ Height = GridLength.Auto ]
                        }
                        ColumnDefinitions {
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                        }
                        TextBlock [ Grid.Column = 0, Text = "Version", Style = @UiCaption, Foreground = @Fg2 ]
                        TextBlock [ Grid.Column = 1, Text = "Channel", Style = @UiCaption, Foreground = @Fg2 ]
                        TextBlock [ Grid.Column = 2, Text = "Signature", Style = @UiCaption, Foreground = @Fg2 ]
                        TextBlock [ Grid.Column = 3, Text = "Status", Style = @UiCaption, Foreground = @Fg2 ]
                        TextBlock [ Grid.Column = 4, Text = "Published", Style = @UiCaption, Foreground = @Fg2 ]
                        TextBlock [ Grid.Column = 5, Text = "Adoption (observed)", Style = @UiCaption, Foreground = @Fg2 ]
                        TextBlock [ Grid.Column = 6, Text = "Image", Style = @UiCaption, Foreground = @Fg2 ]
                    }
                    ListBox [ Style = @PortalTableList, HorizontalAlignment = Stretch, ItemsSource = $Rows, ItemTemplate = @ReleaseRowTemplate ]
                }
            }
        }
    }

    // A releases-table row; the version opens its detail.
    DataTemplate x:key="ReleaseRowTemplate" [ DataType = ReleaseRowViewModel ] {
        Grid [ Style = @PortalTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            Button [ Grid.Column = 0, Variant = Ghost, Command = $OpenCommand, HorizontalAlignment = Left ] {
                TextBlock [ Text = $Version, Style = @UiLabel ]
            }
            TextBlock [ Grid.Column = 1, Text = $ChannelLabel, Foreground = @Fg1, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 2, Text = $SignatureLabel, Foreground = @Fg1, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 3, Text = $StatusLabel, Foreground = @Fg1, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 4, Text = $PublishedLabel, Style = @Code, Foreground = @Fg2, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 5, Text = $AdoptionLabel, Foreground = @Fg1, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 6, Text = $Image, Style = @Code, Foreground = @Fg2, TextWrapping = Wrap, VerticalAlignment = Center ]
        }
    }

    DataTemplate [ DataType = ReleaseDetailPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            // Page header: back, the version, Withdraw / Restore.
            DockPanel [ DockPanel.Dock = Top, Margin = (0,0,0,16) ] {
                Button [ DockPanel.Dock = Right, Variant = Secondary, Command = $RestoreCommand, VerticalAlignment = Top,
                         Visibility = $IsWithdrawn << ToVisibility ] {
                    TextBlock [ Text = "Restore version" ]
                }
                Button [ DockPanel.Dock = Right, Variant = Danger, Command = $WithdrawCommand, VerticalAlignment = Top,
                         Visibility = $IsPublished << ToVisibility ] {
                    TextBlock [ Text = "Withdraw version" ]
                }
                StackPanel [ Orientation = Vertical ] {
                    Button [ Variant = Ghost, Command = $BackCommand, HorizontalAlignment = Left, Margin = (0,0,0,8) ] {
                        TextBlock [ Text = "Back" ]
                    }
                    TextBlock [ Text = $Version, Style = @H3, Foreground = @Fg0 ]
                    StackPanel [ Orientation = Horizontal, Margin = (0,4,0,0) ] {
                        TextBlock [ Text = $StatusLabel, Foreground = @Fg1, Margin = (0,0,12,0) ]
                        TextBlock [ Text = $ChannelLabel, Foreground = @Fg1, Margin = (0,0,12,0) ]
                        TextBlock [ Text = $PublishedLabel, Style = @Code, Foreground = @Fg2 ]
                    }
                    TextBlock [ Text = $DeniedReason, Style = @UiCaption, Foreground = @StateWarningInk, Margin = (0,4,0,0),
                                Visibility = $DeniedReason << ToVisibility ]
                    TextBlock [ Text = $CommandErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,4,0,0),
                                Visibility = $CommandErrorText << ToVisibility ]
                }
            }

            TextBlock [ DockPanel.Dock = Top, Text = "Loading the version...", Foreground = @Fg2,
                        Visibility = $IsLoading << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = $ErrorText, Foreground = @StateDangerInk,
                        TextWrapping = Wrap, Visibility = $IsError << ToVisibility ]

            ScrollViewer [ HorizontalScrollEnabled = false, Visibility = $IsPopulated << ToVisibility ] {
                StackPanel [ Orientation = Vertical ] {
                    Border [ Fill = @StateWarningSoft, Padding = (12,10,12,10), Margin = (0,0,0,16),
                             Visibility = $IsWithdrawn << ToVisibility ] {
                        TextBlock [ Text = $WithdrawnText, Foreground = @StateWarningInk, TextWrapping = Wrap ]
                    }

                    // The manifest and its signature.
                    TextBlock [ Text = "Manifest", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,0,6) ]
                    Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,0,16) ] {
                        Grid {
                            ColumnDefinitions {
                                ColumnDefinition [ Width = GridLength.Star ]
                                ColumnDefinition [ Width = GridLength.Star ]
                                ColumnDefinition [ Width = GridLength.Star ]
                            }
                            StackPanel [ Grid.Column = 0, Orientation = Vertical ] {
                                TextBlock [ Text = "Image", Style = @UiCaption, Foreground = @Fg2 ]
                                TextBlock [ Text = $Image, Style = @Code, Foreground = @Fg0, TextWrapping = Wrap ]
                            }
                            StackPanel [ Grid.Column = 1, Orientation = Vertical ] {
                                TextBlock [ Text = "Digest", Style = @UiCaption, Foreground = @Fg2 ]
                                TextBlock [ Text = $DigestLabel, Style = @Code, Foreground = @Fg0 ]
                            }
                            StackPanel [ Grid.Column = 2, Orientation = Vertical ] {
                                TextBlock [ Text = "Signature", Style = @UiCaption, Foreground = @Fg2 ]
                                TextBlock [ Text = $SignatureLabel, Foreground = @Fg0 ]
                            }
                        }
                    }

                    // What's new, as tenants see it.
                    TextBlock [ Text = "What's new", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,0,6) ]
                    Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,0,16) ] {
                        TextBlock [ Text = $NotesLabel, Foreground = @Fg0, TextWrapping = Wrap ]
                    }

                    // Where it runs: reported by hives on check-in, read-only.
                    StackPanel [ Orientation = Horizontal, Margin = (0,0,0,6) ] {
                        TextBlock [ Text = "Where it runs", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,8,0) ]
                        TextBlock [ Text = "Observed - read-only", Style = @UiCaption, Foreground = @Fg2, VerticalAlignment = Center ]
                    }
                    Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10) ] {
                        StackPanel [ Orientation = Vertical ] {
                            TextBlock [ Text = "No environment runs this version yet.", Foreground = @Fg2,
                                        Visibility = $HasNoAdoption << ToVisibility ]
                            ItemsControl [ ItemsSource = $AdoptionRows, Visibility = $HasAdoption << ToVisibility ]
                        }
                    }
                }
            }
        }
    }

    DataTemplate [ DataType = ReleaseAdoptionRowViewModel ] {
        Grid [ Margin = (0,2,0,2) ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            TextBlock [ Grid.Column = 0, Text = $HiveName, Foreground = @Fg0 ]
            TextBlock [ Grid.Column = 1, Text = $OwnerLabel, Foreground = @Fg1 ]
            TextBlock [ Grid.Column = 2, Text = $Environment, Style = @Code, Foreground = @Fg1 ]
            TextBlock [ Grid.Column = 3, Text = $ReadyLabel, Foreground = @Fg1 ]
        }
    }

    // Publish a version.
    DataTemplate [ DataType = PublishDialogViewModel ] {
        StackPanel [ Orientation = Vertical, Margin = (0,4,0,0) ] {
            TextBlock [ Text = "The image is signed with the platform release key. Every hive verifies the signature and refuses an unsigned image.",
                        TextWrapping = Wrap, Foreground = @Fg2, Margin = (0,0,0,12) ]
            TextBlock [ Text = "Version", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ Text = $Version, Placeholder = "e.g. 4.2.0", Margin = (0,0,0,12) ]
            TextBlock [ Text = "Image", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ Text = $Image, Placeholder = "e.g. registry.example/apps/capability-maps:4.2.0", Margin = (0,0,0,12) ]
            TextBlock [ Text = "Channel", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            ComboBox [ ItemsSource = $Channels, SelectedItem = $SelectedChannel, HorizontalAlignment = Stretch, Margin = (0,0,0,4) ]
            TextBlock [ Text = "Release Policy decides which hives may adopt from each channel.", Style = @UiCaption,
                        Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,0,0,12) ]
            TextBlock [ Text = "What's new (shown to tenants, optional)", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ Text = $Notes, AcceptsReturn = true, TextWrapping = Wrap, Margin = (0,0,0,12) ]
            TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,0,0,12),
                        Visibility = $ErrorText << ToVisibility ]
            StackPanel [ Orientation = Horizontal, HorizontalAlignment = Right ] {
                Button [ Variant = Secondary, Command = $CancelCommand, Margin = (0,0,8,0) ] {
                    TextBlock [ Text = "Cancel" ]
                }
                Button [ Variant = Primary, Command = $ConfirmCommand ] {
                    TextBlock [ Text = "Sign and publish" ]
                }
            }
        }
    }
}
