// overview.resources.mu - the Overview section's views.
//
// OverviewPageViewModel (home) and ActivityPageViewModel are presented
// full-width in the shell's content region, matched implicitly by type.
// ActivityRowTemplate is keyed (a ListBox resolves implicit-by-type templates
// only for MuralBase items) and shared by every activity list in the app;
// OverviewEnvironmentCardTemplate likewise. The cards' status and health
// pills render through the Environments section's implicit
// EnvironmentPillViewModel template.

import OverviewPageViewModel from "./overview-page-view-model.js"
import OverviewEnvironmentCardViewModel from "./overview-page-view-model.js"
import ActivityPageViewModel from "./activity-page-view-model.js"
import ActivityRowViewModel from "./activity-page-view-model.js"

resources OverviewResources {
    DataTemplate [ DataType = OverviewPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            // Page header with its one primary action.
            DockPanel [ DockPanel.Dock = Top, Margin = (0,0,0,16) ] {
                Button [ DockPanel.Dock = Right, Variant = Primary, Command = $CreateCommand, VerticalAlignment = Top ] {
                    TextBlock [ Text = "Create environment" ]
                }
                StackPanel [ Orientation = Vertical ] {
                    TextBlock [ Text = "Overview", Style = @H3, Foreground = @Fg0 ]
                    TextBlock [ Text = $Subtitle, Style = @Body, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,4,0,0) ]
                    TextBlock [ Text = $DeniedReason, Style = @UiCaption, Foreground = @StateWarningInk, Margin = (0,4,0,0),
                                Visibility = $DeniedReason << ToVisibility ]
                    TextBlock [ Text = $CommandErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,4,0,0),
                                Visibility = $CommandErrorText << ToVisibility ]
                }
            }

            // States: loading, error and denied. With no environments the page
            // is still populated: the connection card, the offer and recent
            // activity show, and the environments block says none exist yet.
            TextBlock [ DockPanel.Dock = Top, Text = "Loading your environments...", Foreground = @Fg2,
                        Visibility = $IsLoading << ToVisibility ]
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsError << ToVisibility ] {
                TextBlock [ Text = "Could not load your environments.", Foreground = @StateDangerInk ]
                TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap ]
            }
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsDenied << ToVisibility ] {
                TextBlock [ Text = "You don't have access to this tenant", Style = @UiLabel, Foreground = @Fg0 ]
                StackPanel [ Orientation = Horizontal, Margin = (0,4,0,0) ] {
                    TextBlock [ Text = "This needs an account in this tenant. Ask", Foreground = @Fg2, Margin = (0,0,4,0) ]
                    TextBlock [ Text = $OwnerContact, Foreground = @Fg1 ]
                }
            }

            ScrollViewer [ HorizontalScrollEnabled = false, Visibility = $IsPopulated << ToVisibility ] {
                StackPanel [ Orientation = Vertical ] {
                    // The newer version Pragmatic offers.
                    Border [ Fill = @StateInfoSoft, Padding = (12,10,12,10), Margin = (0,0,0,16),
                             Visibility = $HasOffer << ToVisibility ] {
                        DockPanel {
                            StackPanel [ DockPanel.Dock = Right, Orientation = Vertical, VerticalAlignment = Center, Margin = (12,0,0,0) ] {
                                Button [ Variant = Primary, Command = $ReviewAdoptCommand, HorizontalAlignment = Right ] {
                                    TextBlock [ Text = "Review and adopt" ]
                                }
                                TextBlock [ Text = $AdoptDeniedReason, Style = @UiCaption, Foreground = @StateWarningInk, Margin = (0,4,0,0),
                                            Visibility = $AdoptDeniedReason << ToVisibility ]
                            }
                            StackPanel [ Orientation = Vertical ] {
                                TextBlock [ Text = $OfferTitle, Style = @UiLabel, Foreground = @Fg0 ]
                                TextBlock [ Text = $OfferBody, Foreground = @Fg1, TextWrapping = Wrap, Margin = (0,4,0,0) ]
                            }
                        }
                    }

                    Grid {
                        ColumnDefinitions {
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                        }
                        // Left: the environments and the latest activity.
                        StackPanel [ Grid.Column = 0, Orientation = Vertical, Margin = (0,0,16,0) ] {
                            TextBlock [ Text = "Environments", Style = @TenantSectionCaption ]
                            Border [ Style = @TenantPanel, Visibility = $HasNoEnvironments << ToVisibility ] {
                                StackPanel [ Orientation = Vertical ] {
                                    TextBlock [ Text = "No environments yet", Style = @UiLabel, Foreground = @Fg0 ]
                                    TextBlock [ Text = "An environment is a running workspace that serves Capability Maps to your users. Create one to get a live URL.",
                                                Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,4,0,12) ]
                                    Button [ Variant = Primary, Command = $CreateCommand, HorizontalAlignment = Left ] {
                                        TextBlock [ Text = "Create your first environment" ]
                                    }
                                }
                            }
                            ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $Cards,
                                      ItemTemplate = @OverviewEnvironmentCardTemplate, Margin = (0,0,0,16),
                                      Visibility = $HasEnvironments << ToVisibility ]
                            DockPanel [ Margin = (0,0,0,6) ] {
                                Button [ DockPanel.Dock = Right, Variant = Ghost, Command = $SeeAllActivityCommand ] {
                                    TextBlock [ Text = "See all activity" ]
                                }
                                TextBlock [ Text = "Recent activity", Style = @UiLabel, Foreground = @Fg0, VerticalAlignment = Center ]
                            }
                            Border [ Style = @TenantPanel ] {
                                StackPanel [ Orientation = Vertical ] {
                                    TextBlock [ Text = "No activity observed yet this session.", Foreground = @Fg2,
                                                Visibility = $HasNoRecentActivity << ToVisibility ]
                                    ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $RecentActivity,
                                              ItemTemplate = @ActivityRowTemplate, Visibility = $HasRecentActivity << ToVisibility ]
                                }
                            }
                        }
                        // Right: the connection to Pragmatic.
                        StackPanel [ Grid.Column = 1, Orientation = Vertical ] {
                            TextBlock [ Text = "Connection to Pragmatic", Style = @TenantSectionCaption ]
                            Border [ Style = @TenantPanel ] {
                                StackPanel [ Orientation = Vertical ] {
                                    StackPanel [ Orientation = Horizontal, Margin = (0,0,0,8), Visibility = $HasConnectionPill << ToVisibility ] {
                                        Border [ Fill = @StateSuccessSoft, Padding = (8,2,8,2), Visibility = $IsConnected << ToVisibility ] {
                                            TextBlock [ Text = $ConnectionLabel, Style = @UiCaption, Foreground = @StateSuccessInk ]
                                        }
                                        Border [ Fill = @StateWarningSoft, Padding = (8,2,8,2), Visibility = $IsQuiet << ToVisibility ] {
                                            TextBlock [ Text = $ConnectionLabel, Style = @UiCaption, Foreground = @StateWarningInk ]
                                        }
                                    }
                                    TextBlock [ Text = $ConnectionText, Foreground = @Fg1, TextWrapping = Wrap ]
                                    TextBlock [ Text = "Your hive dials out to Pragmatic; Pragmatic can't connect into your hive.",
                                                Style = @UiCaption, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,8,0,0) ]
                                    Button [ Variant = Ghost, Command = $ViewConnectionCommand, HorizontalAlignment = Left, Margin = (0,8,0,0) ] {
                                        TextBlock [ Text = "View connection status" ]
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // One environment card; the name opens the environment's detail.
    DataTemplate x:key="OverviewEnvironmentCardTemplate" [ DataType = OverviewEnvironmentCardViewModel ] {
        Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (4,8,12,8), Margin = (0,0,0,8) ] {
            StackPanel [ Orientation = Vertical ] {
                DockPanel {
                    ContentControl [ DockPanel.Dock = Right, Content = $StatusPill, VerticalAlignment = Center ]
                    Button [ Variant = Ghost, Command = $OpenCommand, HorizontalAlignment = Left ] {
                        TextBlock [ Text = $Name, Style = @UiLabel ]
                    }
                }
                StackPanel [ Orientation = Horizontal, Margin = (18,4,0,0) ] {
                    ContentControl [ Content = $HealthPill, VerticalAlignment = Center, Margin = (0,0,12,0) ]
                    TextBlock [ Text = $Template, Foreground = @Fg2, VerticalAlignment = Center, Margin = (0,0,8,0) ]
                    TextBlock [ Text = $Version, Style = @Code, Foreground = @Fg1, VerticalAlignment = Center ]
                }
                TextBlock [ Text = $UrlText, Style = @Code, Foreground = @Fg2, Margin = (18,4,0,0) ]
            }
        }
    }

    DataTemplate x:key="ActivityRowTemplate" [ DataType = ActivityRowViewModel ] {
        DockPanel [ Margin = (8,4,8,4) ] {
            TextBlock [ DockPanel.Dock = Right, Text = $WhenLabel, Style = @UiCaption, Foreground = @Fg2, Margin = (12,0,0,0) ]
            TextBlock [ Text = $Summary, Foreground = @Fg1, TextWrapping = Wrap ]
        }
    }

    DataTemplate [ DataType = ActivityPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Margin = (0,0,0,16) ] {
                Button [ Variant = Ghost, Command = $BackCommand, HorizontalAlignment = Left, Margin = (0,0,0,8) ] {
                    TextBlock [ Text = "Back" ]
                }
                TextBlock [ Text = "Activity", Style = @H3, Foreground = @Fg0 ]
                TextBlock [ Text = "Changes to your environments observed while this page has been open. Newest first.",
                            Style = @Body, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,4,0,0) ]
            }
            TextBlock [ DockPanel.Dock = Top, Text = "No activity observed yet this session.", Foreground = @Fg2,
                        Visibility = $IsEmpty << ToVisibility ]
            ScrollViewer [ HorizontalScrollEnabled = false, Visibility = $IsPopulated << ToVisibility ] {
                ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $Rows,
                          ItemTemplate = @ActivityRowTemplate ]
            }
        }
    }
}
