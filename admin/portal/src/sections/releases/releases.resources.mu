// releases.resources.mu - the Registry & Releases section's views.
//
// ReleasesPageViewModel (the list) and ReleaseDetailPageViewModel are
// presented full-width in the shell's content region, matched implicitly by
// type. Where a version runs is observed (reported by hives), read-only.
// Versions come from the release registry (Refresh from registry); a registry
// release's detail adds its provenance and images. Withdraw uses the shared
// name-to-confirm dialog (shell resources) with a reason.
//
// The releases table uses a keyed row template set as the ListBox's
// ItemTemplate (a ListBox resolves implicit templates only for MuralBase
// items) and the shared PortalTable ListBox template.

import ReleasesPageViewModel from "./releases-page-view-model.js"
import ReleaseRowViewModel from "./releases-page-view-model.js"
import ReleaseDetailPageViewModel from "./release-detail-page-view-model.js"
import ReleaseAdoptionRowViewModel from "./release-detail-page-view-model.js"
import ReleaseImageRowViewModel from "./release-detail-page-view-model.js"
import ReleaseSiblingCommitRowViewModel from "./release-detail-page-view-model.js"

resources ReleasesResources {
    DataTemplate [ DataType = ReleasesPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            DockPanel [ DockPanel.Dock = Top, Margin = (0,0,0,16) ] {
                Button [ DockPanel.Dock = Right, Variant = Primary, Command = $RefreshFromRegistryCommand, VerticalAlignment = Top ] {
                    TextBlock [ Text = "Refresh from registry" ]
                }
                StackPanel [ Orientation = Vertical ] {
                    TextBlock [ Text = "Registry & Releases", Style = @H3, Foreground = @Fg0 ]
                    TextBlock [ Text = "Signed releases from the release registry. Hives are offered these; tenants choose when to adopt.",
                                Style = @Body, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,4,0,0) ]
                    TextBlock [ Text = $DeniedReason, Style = @UiCaption, Foreground = @StateWarningInk, Margin = (0,4,0,0),
                                Visibility = $DeniedReason << ToVisibility ]
                    TextBlock [ Text = $RefreshResultText, Style = @UiCaption, Foreground = @Fg1, Margin = (0,4,0,0),
                                Visibility = $RefreshResultText << ToVisibility ]
                    TextBlock [ Text = $CommandErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,4,0,0),
                                Visibility = $CommandErrorText << ToVisibility ]
                }
            }

            TextBlock [ DockPanel.Dock = Top, Text = "Loading versions...", Foreground = @Fg2,
                        Visibility = $IsLoading << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = "No versions yet. Refresh from registry to import and verify the signed releases. Nothing is pushed: tenants adopt when they choose.",
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
                            ColumnDefinition [ Width = GridLength.Star ]
                        }
                        TextBlock [ Grid.Column = 0, Text = "Version", Style = @PortalTableLinkHeader ]
                        TextBlock [ Grid.Column = 1, Text = "Channel", Style = @PortalTableHeader ]
                        TextBlock [ Grid.Column = 2, Text = "Verification", Style = @PortalTableHeader ]
                        TextBlock [ Grid.Column = 3, Text = "Signature", Style = @PortalTableHeader ]
                        TextBlock [ Grid.Column = 4, Text = "Status", Style = @PortalTableHeader ]
                        TextBlock [ Grid.Column = 5, Text = "Published", Style = @PortalTableHeader ]
                        TextBlock [ Grid.Column = 6, Text = "Adoption (observed)", Style = @PortalTableHeader ]
                        TextBlock [ Grid.Column = 7, Text = "Image", Style = @PortalTableHeader ]
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
                ColumnDefinition [ Width = GridLength.Star ]
            }
            Button [ Grid.Column = 0, Variant = Ghost, Command = $OpenCommand, HorizontalAlignment = Left ] {
                TextBlock [ Text = $Version, Style = @UiLabel ]
            }
            TextBlock [ Grid.Column = 1, Text = $ChannelLabel, Foreground = @Fg1, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 2, Text = $VerificationLabel, Foreground = @Fg1, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 3, Text = $SignatureLabel, Foreground = @Fg1, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 4, Text = $StatusLabel, Foreground = @Fg1, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 5, Text = $PublishedLabel, Style = @Code, Foreground = @Fg2, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 6, Text = $AdoptionLabel, Foreground = @Fg1, VerticalAlignment = Center, TextTrimming = CharacterEllipsis ]
            // A by-digest reference has no break point: one line, ellipsed, the full reference on hover.
            TextBlock [ Grid.Column = 7, Text = $Image, Style = @Code, Foreground = @Fg2, VerticalAlignment = Center,
                        TextTrimming = CharacterEllipsis, ToolTipService.ToolTip = $Image ]
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
                        // The image on its own line: a by-digest reference is long and unbreakable.
                        StackPanel [ Orientation = Vertical ] {
                            TextBlock [ Text = "Image", Style = @UiCaption, Foreground = @Fg2 ]
                            TextBlock [ Text = $Image, Style = @Code, Foreground = @Fg0, TextWrapping = Wrap, Margin = (0,0,0,8) ]
                            Grid {
                                ColumnDefinitions {
                                    ColumnDefinition [ Width = GridLength.Star ]
                                    ColumnDefinition [ Width = GridLength.Star ]
                                }
                                StackPanel [ Grid.Column = 0, Orientation = Vertical ] {
                                    TextBlock [ Text = "Digest", Style = @UiCaption, Foreground = @Fg2 ]
                                    TextBlock [ Text = $DigestLabel, Style = @Code, Foreground = @Fg0 ]
                                }
                                StackPanel [ Grid.Column = 1, Orientation = Vertical ] {
                                    TextBlock [ Text = "Signature", Style = @UiCaption, Foreground = @Fg2 ]
                                    TextBlock [ Text = $SignatureLabel, Foreground = @Fg0 ]
                                }
                            }
                        }
                    }

                    // A registry release's provenance; a local manifest has none.
                    // A commit or digest shows short, the full value on hover.
                    StackPanel [ Orientation = Vertical, Visibility = $HasRelease << ToVisibility ] {
                        TextBlock [ Text = "Release", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,0,6) ]
                        Border [ Fill = @StateDangerSoft, Padding = (12,10,12,10), Margin = (0,0,0,16),
                                 Visibility = $IsRejected << ToVisibility ] {
                            StackPanel [ Orientation = Vertical ] {
                                TextBlock [ Text = "Rejected on import: nothing about it is trusted, it records no image and it cannot be gated.", Foreground = @StateDangerInk, TextWrapping = Wrap ]
                                TextBlock [ Text = $RejectedReason, Style = @Code, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,4,0,0) ]
                            }
                        }
                        // Build provenance: only a verified release's is trusted (and present).
                        Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,0,16),
                                 Visibility = $IsVerified << ToVisibility ] {
                            Grid {
                                ColumnDefinitions {
                                    ColumnDefinition [ Width = GridLength.Star ]
                                    ColumnDefinition [ Width = GridLength.Star ]
                                    ColumnDefinition [ Width = GridLength.Star ]
                                    ColumnDefinition [ Width = GridLength.Star ]
                                }
                                StackPanel [ Grid.Column = 0, Orientation = Vertical ] {
                                    TextBlock [ Text = "Verification", Style = @UiCaption, Foreground = @Fg2 ]
                                    TextBlock [ Text = $VerificationLabel, Foreground = @Fg0 ]
                                }
                                StackPanel [ Grid.Column = 1, Orientation = Vertical ] {
                                    TextBlock [ Text = "Built", Style = @UiCaption, Foreground = @Fg2 ]
                                    TextBlock [ Text = $BuiltAtLabel, Style = @Code, Foreground = @Fg0 ]
                                }
                                StackPanel [ Grid.Column = 2, Orientation = Vertical ] {
                                    TextBlock [ Text = "Server commit", Style = @UiCaption, Foreground = @Fg2 ]
                                    TextBlock [ Text = $ServerCommitShort, Style = @Code, Foreground = @Fg0,
                                                ToolTipService.ToolTip = $ServerCommit ]
                                }
                                StackPanel [ Grid.Column = 3, Orientation = Vertical ] {
                                    TextBlock [ Text = "Signer key", Style = @UiCaption, Foreground = @Fg2 ]
                                    TextBlock [ Text = $SigningKeyId, Style = @Code, Foreground = @Fg0 ]
                                }
                            }
                        }

                        StackPanel [ Orientation = Vertical, Visibility = $HasImages << ToVisibility ] {
                            TextBlock [ Text = "Images", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,0,6) ]
                            Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,0,16) ] {
                                ListBox [ Style = @PortalTableList, HorizontalAlignment = Stretch, ItemsSource = $ImageRows, ItemTemplate = @ReleaseImageRowTemplate ]
                            }
                        }

                        StackPanel [ Orientation = Vertical, Visibility = $HasSiblingCommits << ToVisibility ] {
                            TextBlock [ Text = "Sibling commits", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,0,6) ]
                            Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,0,16) ] {
                                ListBox [ Style = @PortalTableList, HorizontalAlignment = Stretch, ItemsSource = $SiblingCommitRows, ItemTemplate = @ReleaseSiblingCommitRowTemplate ]
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
                            ListBox [ Style = @PortalTableList, HorizontalAlignment = Stretch, ItemsSource = $AdoptionRows, ItemTemplate = @ReleaseAdoptionRowTemplate,
                                      Visibility = $HasAdoption << ToVisibility ]
                        }
                    }
                }
            }
        }
    }

    DataTemplate x:key="ReleaseAdoptionRowTemplate" [ DataType = ReleaseAdoptionRowViewModel ] {
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

    // One image of a registry release: app, short digest (full on hover), repository.
    DataTemplate x:key="ReleaseImageRowTemplate" [ DataType = ReleaseImageRowViewModel ] {
        Grid [ Margin = (0,2,0,2) ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            TextBlock [ Grid.Column = 0, Text = $App, Style = @Code, Foreground = @Fg0 ]
            TextBlock [ Grid.Column = 1, Text = $DigestLabel, Style = @Code, Foreground = @Fg1, ToolTipService.ToolTip = $Digest ]
            TextBlock [ Grid.Column = 2, Text = $Repository, Style = @Code, Foreground = @Fg2, TextWrapping = Wrap ]
        }
    }

    // One sibling repository and its short commit (full on hover).
    DataTemplate x:key="ReleaseSiblingCommitRowTemplate" [ DataType = ReleaseSiblingCommitRowViewModel ] {
        Grid [ Margin = (0,2,0,2) ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            TextBlock [ Grid.Column = 0, Text = $Repo, Foreground = @Fg0 ]
            TextBlock [ Grid.Column = 1, Text = $CommitShort, Style = @Code, Foreground = @Fg1, ToolTipService.ToolTip = $Commit ]
        }
    }
}
