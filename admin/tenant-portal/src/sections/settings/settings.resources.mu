// settings.resources.mu - the Settings section's view.
//
// SettingsPageViewModel is presented full-width in the shell's content
// region, matched implicitly by type. Read-only: every value is managed by
// the platform, so there is no action anywhere on the page. The tab strip is
// a SegmentedButton over the tab labels (two-way SelectedItem); each tab's
// content shows by its Visibility flag. Key / value lists use a keyed row
// template set as the ListBox's ItemTemplate (a ListBox resolves
// implicit-by-type templates only for MuralBase items).

import SettingsPageViewModel from "./settings-page-view-model.js"
import SettingRowViewModel from "./settings-page-view-model.js"

resources SettingsResources {
    DataTemplate x:key="SettingRowTemplate" [ DataType = SettingRowViewModel ] {
        Grid [ Style = @TenantTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            TextBlock [ Grid.Column = 0, Text = $Key, Style = @TenantKey, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 1, Text = $Value, Foreground = @Fg0 ]
        }
    }

    DataTemplate [ DataType = SettingsPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Margin = (0,0,0,16) ] {
                TextBlock [ Text = "Settings", Style = @H3, Foreground = @Fg0 ]
                TextBlock [ Text = "Read-only view of how your tenant is set up.",
                            Style = @Body, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,4,0,0) ]
            }

            TextBlock [ DockPanel.Dock = Top, Text = "Loading the settings...", Foreground = @Fg2,
                        Visibility = $IsLoading << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = "No settings to show yet.", Foreground = @Fg2,
                        Visibility = $IsEmpty << ToVisibility ]
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsError << ToVisibility ] {
                TextBlock [ Text = "Could not load the settings.", Foreground = @StateDangerInk ]
                TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap ]
            }
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsDenied << ToVisibility ] {
                TextBlock [ Text = "You don't have access to the settings", Style = @UiLabel, Foreground = @Fg0 ]
                StackPanel [ Orientation = Horizontal, Margin = (0,4,0,0) ] {
                    TextBlock [ Text = "This needs access to your tenant. Ask", Foreground = @Fg2, Margin = (0,0,4,0) ]
                    TextBlock [ Text = $OwnerContact, Foreground = @Fg1 ]
                }
            }

            DockPanel [ Visibility = $IsPopulated << ToVisibility ] {
                SegmentedButton [ DockPanel.Dock = Top, ItemsSource = $TabLabels, SelectedItem = $SelectedTab, SelectionMode = Single,
                                  HorizontalAlignment = Left, Margin = (0,0,0,16) ]

                ScrollViewer [ HorizontalScrollEnabled = false ] {
                    StackPanel [ Orientation = Vertical ] {
                        // Hive & domain.
                        StackPanel [ Orientation = Vertical, Visibility = $IsHiveTab << ToVisibility ] {
                            TextBlock [ Text = "These settings are managed by the platform and are read-only here.",
                                        Style = @UiCaption, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,0,0,8) ]
                            TextBlock [ Text = "No hive has been set up for this tenant yet.", Foreground = @Fg2,
                                        Visibility = $HasNoHive << ToVisibility ]
                            Border [ Style = @TenantPanel, Visibility = $HasHive << ToVisibility ] {
                                ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $HiveRows,
                                          ItemTemplate = @SettingRowTemplate ]
                            }
                        }

                        // Tenant profile.
                        StackPanel [ Orientation = Vertical, Visibility = $IsProfileTab << ToVisibility ] {
                            TextBlock [ Text = "Profile changes are made by the platform operator.",
                                        Style = @UiCaption, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,0,0,8) ]
                            Border [ Style = @TenantPanel ] {
                                ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $ProfileRows,
                                          ItemTemplate = @SettingRowTemplate ]
                            }
                        }

                        // Identity provider, by reference only.
                        StackPanel [ Orientation = Vertical, Visibility = $IsIdentityProviderTab << ToVisibility ] {
                            TextBlock [ Text = "Identity provider credentials are managed by the platform and are shown by reference only.",
                                        Style = @UiCaption, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,0,0,8) ]
                            TextBlock [ Text = "No identity provider configured.", Foreground = @Fg2,
                                        Visibility = $HasNoIdp << ToVisibility ]
                            Border [ Style = @TenantPanel, Visibility = $HasIdp << ToVisibility ] {
                                ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $IdpRows,
                                          ItemTemplate = @SettingRowTemplate ]
                            }
                        }
                    }
                }
            }
        }
    }
}
