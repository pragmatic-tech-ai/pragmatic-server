// configuration.resources.mu - the Configuration section's views.
//
// ConfigurationPageViewModel (the components list) and
// ComponentConfigurationPageViewModel (one component) are presented
// full-width in the shell's content region, matched implicitly by type.
// Table rows use keyed templates set as each ListBox's ItemTemplate (a
// ListBox resolves implicit-by-type templates only for MuralBase items, and
// the rows are Observables).
//
// A component's page reads top to bottom: its settings (what the descriptor
// declares; a secret setting takes a secret reference, never a value), its
// targets (what is applied where), its versions (View shows one document),
// Compare (two versions, or the empty document and a version), and, for a
// session holding the settings permission, New version (the head's document
// as JSON text, the server's validation errors by path, the head-moved
// notice) and Apply (a version to one target environment), then the applies.
// Without the permission those two panels are replaced by the reason.

import ConfigurationPageViewModel from "./configuration-page-view-model.js"
import ConfigurationComponentRowViewModel from "./configuration-page-view-model.js"
import ComponentConfigurationPageViewModel from "./component-configuration-page-view-model.js"
import ConfigurationSettingRowViewModel from "./configuration-rows.js"
import ConfigurationVersionRowViewModel from "./configuration-rows.js"
import ConfigurationTargetRowViewModel from "./configuration-rows.js"
import ConfigurationApplyRowViewModel from "./configuration-rows.js"
import ConfigurationChangeRowViewModel from "./configuration-rows.js"
import ConfigurationErrorRowViewModel from "./configuration-rows.js"

resources ConfigurationResources {
    DataTemplate [ DataType = ConfigurationPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Margin = (0,0,0,16) ] {
                TextBlock [ Text = "Configuration", Style = @H3, Foreground = @Fg0 ]
                TextBlock [ Text = "The settings of the components your hive runs, kept as versions. Each version is checked against the component's descriptor before it is saved, and applied to one environment at a time.",
                            Style = @Body, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,4,0,0) ]
            }

            TextBlock [ DockPanel.Dock = Top, Text = "Loading the configuration...", Foreground = @Fg2,
                        Visibility = $IsLoading << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = "No component here takes configuration yet.", Foreground = @Fg2,
                        TextWrapping = Wrap, Visibility = $IsEmpty << ToVisibility ]
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsError << ToVisibility ] {
                TextBlock [ Text = "Could not load the configuration.", Foreground = @StateDangerInk ]
                TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap ]
            }
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsDenied << ToVisibility ] {
                TextBlock [ Text = "You don't have access to the configuration", Style = @UiLabel, Foreground = @Fg0 ]
                StackPanel [ Orientation = Horizontal, Margin = (0,4,0,0) ] {
                    TextBlock [ Text = "Ask", Foreground = @Fg2, Margin = (0,0,4,0) ]
                    TextBlock [ Text = $OwnerContact, Foreground = @Fg1 ]
                }
            }

            ScrollViewer [ HorizontalScrollEnabled = false, Visibility = $IsPopulated << ToVisibility ] {
                StackPanel [ Orientation = Vertical ] {
                    Grid [ Style = @TenantTableColumns ] {
                        ColumnDefinitions {
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                        }
                        TextBlock [ Grid.Column = 0, Text = "Component", Style = @TenantTableLinkHeader ]
                        TextBlock [ Grid.Column = 1, Text = "Head", Style = @TenantTableHeader ]
                        TextBlock [ Grid.Column = 2, Text = "Applied", Style = @TenantTableHeader ]
                    }
                    ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $Rows,
                              ItemTemplate = @ConfigurationComponentRowTemplate ]
                }
            }
        }
    }

    // A component row; the name opens the component's page.
    DataTemplate x:key="ConfigurationComponentRowTemplate" [ DataType = ConfigurationComponentRowViewModel ] {
        Grid [ Style = @TenantTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            StackPanel [ Grid.Column = 0, Orientation = Vertical, VerticalAlignment = Center ] {
                Button [ Variant = Ghost, Command = $OpenCommand, HorizontalAlignment = Left ] {
                    TextBlock [ Text = $Component, Style = @UiLabel ]
                }
                TextBlock [ Text = $ComponentVersion, Style = @Code, Foreground = @Fg2, Margin = (18,0,0,0) ]
            }
            TextBlock [ Grid.Column = 1, Text = $HeadText, Foreground = @Fg1, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 2, Text = $TargetsText, Foreground = @Fg1, TextWrapping = Wrap, VerticalAlignment = Center ]
        }
    }

    DataTemplate [ DataType = ComponentConfigurationPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Margin = (0,0,0,12) ] {
                Button [ Variant = Ghost, Command = $BackCommand, HorizontalAlignment = Left, Margin = (0,0,0,8) ] {
                    TextBlock [ Text = "Back to configuration" ]
                }
                TextBlock [ Text = $Title, Style = @H3, Foreground = @Fg0 ]
                StackPanel [ Orientation = Horizontal, Margin = (0,4,0,0) ] {
                    TextBlock [ Text = $ComponentVersionText, Style = @Code, Foreground = @Fg2, Margin = (0,0,16,0) ]
                    TextBlock [ Text = $HeadText, Foreground = @Fg1 ]
                }
                TextBlock [ Text = $NoticeText, Foreground = @StateSuccessInk, TextWrapping = Wrap, Margin = (0,8,0,0),
                            Visibility = $NoticeText << ToVisibility ]
                TextBlock [ Text = $CommandErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,8,0,0),
                            Visibility = $CommandErrorText << ToVisibility ]
            }

            TextBlock [ DockPanel.Dock = Top, Text = "Loading the component...", Foreground = @Fg2,
                        Visibility = $IsLoading << ToVisibility ]
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsError << ToVisibility ] {
                TextBlock [ Text = "Could not load this component.", Foreground = @StateDangerInk ]
                TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap ]
            }
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsDenied << ToVisibility ] {
                TextBlock [ Text = "You don't have access to this component's configuration", Style = @UiLabel, Foreground = @Fg0 ]
                StackPanel [ Orientation = Horizontal, Margin = (0,4,0,0) ] {
                    TextBlock [ Text = "Ask", Foreground = @Fg2, Margin = (0,0,4,0) ]
                    TextBlock [ Text = $OwnerContact, Foreground = @Fg1 ]
                }
            }

            ScrollViewer [ HorizontalScrollEnabled = false, Visibility = $IsPopulated << ToVisibility ] {
                StackPanel [ Orientation = Vertical ] {
                    // Settings: what the component's descriptor declares.
                    TextBlock [ Text = "Settings", Style = @TenantSectionCaption ]
                    Border [ Style = @TenantPanel ] {
                        StackPanel [ Orientation = Vertical ] {
                            TextBlock [ Text = "A secret setting takes a secret reference such as secret:<store>/<name>. The secret itself stays in its store and is never entered here.",
                                        Style = @UiCaption, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,0,0,8) ]
                            TextBlock [ Text = "This component declares no settings.", Foreground = @Fg2,
                                        Visibility = $HasNoSettings << ToVisibility ]
                            ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $SettingRows,
                                      ItemTemplate = @ConfigurationSettingRowTemplate, Visibility = $HasSettings << ToVisibility ]
                        }
                    }

                    // Targets: where the component runs, and what is applied there.
                    TextBlock [ Text = "Targets", Style = @TenantSectionCaption ]
                    Border [ Style = @TenantPanel ] {
                        StackPanel [ Orientation = Vertical ] {
                            TextBlock [ Text = "This component runs in no environment yet.", Foreground = @Fg2,
                                        Visibility = $HasNoTargets << ToVisibility ]
                            ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $TargetRows,
                                      ItemTemplate = @ConfigurationTargetRowTemplate, Visibility = $HasTargets << ToVisibility ]
                        }
                    }

                    // Versions: newest first; View shows one document.
                    TextBlock [ Text = "Versions", Style = @TenantSectionCaption ]
                    Border [ Style = @TenantPanel ] {
                        StackPanel [ Orientation = Vertical ] {
                            TextBlock [ Text = "No version saved yet.", Foreground = @Fg2,
                                        Visibility = $HasNoVersions << ToVisibility ]
                            ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $VersionRows,
                                      ItemTemplate = @ConfigurationVersionRowTemplate, Visibility = $HasVersions << ToVisibility ]
                            StackPanel [ Orientation = Vertical, Margin = (0,12,0,0), Visibility = $HasViewed << ToVisibility ] {
                                TextBlock [ Text = $ViewedTitle, Style = @UiLabel, Foreground = @Fg0, Margin = (0,0,0,4) ]
                                Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10) ] {
                                    TextBlock [ Text = $ViewedDocumentText, Style = @Code, Foreground = @Fg0, TextWrapping = Wrap ]
                                }
                            }
                        }
                    }

                    // Compare: two versions, or the empty document and a version.
                    TextBlock [ Text = "Compare", Style = @TenantSectionCaption, Visibility = $HasVersions << ToVisibility ]
                    Border [ Style = @TenantPanel, Visibility = $HasVersions << ToVisibility ] {
                        StackPanel [ Orientation = Vertical ] {
                            StackPanel [ Orientation = Horizontal, Margin = (0,0,0,8) ] {
                                TextBlock [ Text = "From", Style = @UiCaption, Foreground = @Fg2, VerticalAlignment = Center, Margin = (0,0,8,0) ]
                                ComboBox [ ItemsSource = $FromOptions, SelectedItem = $SelectedFrom, Margin = (0,0,16,0) ]
                                TextBlock [ Text = "To", Style = @UiCaption, Foreground = @Fg2, VerticalAlignment = Center, Margin = (0,0,8,0) ]
                                ComboBox [ ItemsSource = $ToOptions, SelectedItem = $SelectedTo, Margin = (0,0,16,0) ]
                                Button [ Variant = Secondary, Command = $CompareCommand ] {
                                    TextBlock [ Text = "Compare" ]
                                }
                            }
                            TextBlock [ Text = $DiffSummaryText, Foreground = @Fg1, Margin = (0,0,0,8),
                                        Visibility = $DiffSummaryText << ToVisibility ]
                            ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $ChangeRows,
                                      ItemTemplate = @ConfigurationChangeRowTemplate, Visibility = $HasChanges << ToVisibility ]
                        }
                    }

                    // Why the edits are not offered, for a session without the settings permission.
                    Border [ Fill = @StateWarningSoft, Padding = (12,8,12,8), Margin = (0,16,0,0),
                             Visibility = $DeniedReason << ToVisibility ] {
                        TextBlock [ Text = $DeniedReason, Foreground = @StateWarningInk, TextWrapping = Wrap ]
                    }

                    // New version (the head's document as JSON text) and Apply (one version to one target
                    // environment), for a session holding the settings permission.
                    StackPanel [ Orientation = Vertical, Visibility = $CanMutate << ToVisibility ] {
                        TextBlock [ Text = "New version", Style = @TenantSectionCaption ]
                        Border [ Style = @TenantPanel ] {
                            StackPanel [ Orientation = Vertical, DataContext = $Editor ] {
                                TextBlock [ Text = $BasedOnText, Foreground = @Fg2, Margin = (0,0,0,8) ]
                                TextBox [ Text = $Text, AcceptsReturn = true, MinHeight = 200, Margin = (0,0,0,4) ]
                                TextBlock [ Text = $ParseErrorText, Style = @UiCaption, Foreground = @StateDangerInk, Margin = (0,0,0,8),
                                            Visibility = $ParseErrorText << ToVisibility ]
                                TextBlock [ Text = "Comment", Style = @UiCaption, Foreground = @Fg2, Margin = (0,8,0,4) ]
                                TextBox [ UsesNativeInput = true, Text = $Comment, Placeholder = "What this version changes", Margin = (0,0,0,12) ]
                                Border [ Fill = @StateWarningSoft, Padding = (12,8,12,8), Margin = (0,0,0,12),
                                         Visibility = $HasConflict << ToVisibility ] {
                                    TextBlock [ Text = $ConflictText, Foreground = @StateWarningInk, TextWrapping = Wrap ]
                                }
                                StackPanel [ Orientation = Vertical, Margin = (0,0,0,12), Visibility = $HasErrors << ToVisibility ] {
                                    TextBlock [ Text = "The server did not accept this version:", Foreground = @StateDangerInk, Margin = (0,0,0,4) ]
                                    ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $ErrorRows,
                                              ItemTemplate = @ConfigurationErrorRowTemplate ]
                                }
                            }
                        }
                        StackPanel [ Orientation = Horizontal, Margin = (0,0,0,8) ] {
                            Button [ Variant = Primary, Command = $SaveCommand, Margin = (0,0,8,0) ] {
                                TextBlock [ Text = "Save version" ]
                            }
                            Button [ Variant = Secondary, Command = $ReloadEditorCommand ] {
                                TextBlock [ Text = "Start again from the head" ]
                            }
                        }

                        TextBlock [ Text = "Apply", Style = @TenantSectionCaption ]
                        Border [ Style = @TenantPanel ] {
                            StackPanel [ Orientation = Horizontal ] {
                                TextBlock [ Text = "Version", Style = @UiCaption, Foreground = @Fg2, VerticalAlignment = Center, Margin = (0,0,8,0) ]
                                ComboBox [ ItemsSource = $ApplyVersionOptions, SelectedItem = $SelectedApplyVersion, Margin = (0,0,16,0) ]
                                TextBlock [ Text = "to", Style = @UiCaption, Foreground = @Fg2, VerticalAlignment = Center, Margin = (0,0,8,0) ]
                                ComboBox [ ItemsSource = $TargetOptions, SelectedItem = $SelectedTarget, Placeholder = "Choose environment",
                                           Margin = (0,0,16,0) ]
                                Button [ Variant = Primary, Command = $ApplyCommand ] {
                                    TextBlock [ Text = "Apply" ]
                                }
                            }
                        }
                    }

                    // Applies: newest first.
                    TextBlock [ Text = "Applies", Style = @TenantSectionCaption, Visibility = $HasApplies << ToVisibility ]
                    Border [ Style = @TenantPanel, Visibility = $HasApplies << ToVisibility ] {
                        ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $ApplyRows,
                                  ItemTemplate = @ConfigurationApplyRowTemplate ]
                    }
                }
            }
        }
    }

    DataTemplate x:key="ConfigurationSettingRowTemplate" [ DataType = ConfigurationSettingRowViewModel ] {
        Grid [ Style = @TenantTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            TextBlock [ Grid.Column = 0, Text = $Path, Style = @Code, Foreground = @Fg0, VerticalAlignment = Center ]
            StackPanel [ Grid.Column = 1, Orientation = Vertical, VerticalAlignment = Center ] {
                TextBlock [ Text = $TypeText, Foreground = @Fg1 ]
                TextBlock [ Text = $RequiredText, Style = @UiCaption, Foreground = @Fg2 ]
            }
            TextBlock [ Grid.Column = 2, Text = $DefaultText, Style = @Code, Foreground = @Fg2, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 3, Text = $Description, Foreground = @Fg2, TextWrapping = Wrap, VerticalAlignment = Center ]
        }
    }

    DataTemplate x:key="ConfigurationTargetRowTemplate" [ DataType = ConfigurationTargetRowViewModel ] {
        Grid [ Style = @TenantTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            TextBlock [ Grid.Column = 0, Text = $Environment, Style = @UiLabel, Foreground = @Fg0, VerticalAlignment = Center ]
            StackPanel [ Grid.Column = 1, Orientation = Vertical, VerticalAlignment = Center ] {
                TextBlock [ Text = $Namespace, Style = @Code, Foreground = @Fg1 ]
                TextBlock [ Text = $Deployment, Style = @Code, Foreground = @Fg2 ]
            }
            TextBlock [ Grid.Column = 2, Text = $AppliedText, Foreground = @Fg1, VerticalAlignment = Center ]
        }
    }

    DataTemplate x:key="ConfigurationVersionRowTemplate" [ DataType = ConfigurationVersionRowViewModel ] {
        Grid [ Style = @TenantTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Auto ]
            }
            StackPanel [ Grid.Column = 0, Orientation = Horizontal, VerticalAlignment = Center ] {
                TextBlock [ Text = $VersionText, Style = @UiLabel, Foreground = @Fg0, Margin = (0,0,8,0) ]
                Border [ Fill = @StateSuccessSoft, Padding = (6,1,6,1), Visibility = $IsHead << ToVisibility ] {
                    TextBlock [ Text = "Head", Style = @UiCaption, Foreground = @StateSuccessInk ]
                }
            }
            StackPanel [ Grid.Column = 1, Orientation = Vertical, VerticalAlignment = Center ] {
                TextBlock [ Text = $Author, Foreground = @Fg1 ]
                TextBlock [ Text = $CreatedText, Style = @UiCaption, Foreground = @Fg2 ]
            }
            TextBlock [ Grid.Column = 2, Text = $Comment, Foreground = @Fg2, TextWrapping = Wrap, VerticalAlignment = Center ]
            Button [ Grid.Column = 3, Variant = Ghost, Command = $ViewCommand, VerticalAlignment = Center ] {
                TextBlock [ Text = "View" ]
            }
        }
    }

    DataTemplate x:key="ConfigurationChangeRowTemplate" [ DataType = ConfigurationChangeRowViewModel ] {
        Grid [ Style = @TenantTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Auto ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            TextBlock [ Grid.Column = 0, Text = $Path, Style = @Code, Foreground = @Fg0, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 1, Text = $KindText, Style = @UiCaption, Foreground = @Fg1, VerticalAlignment = Center, Margin = (0,0,16,0) ]
            TextBlock [ Grid.Column = 2, Text = $BeforeText, Style = @Code, Foreground = @Fg2, TextWrapping = Wrap, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 3, Text = $AfterText, Style = @Code, Foreground = @Fg0, TextWrapping = Wrap, VerticalAlignment = Center ]
        }
    }

    DataTemplate x:key="ConfigurationErrorRowTemplate" [ DataType = ConfigurationErrorRowViewModel ] {
        Grid [ Style = @TenantTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            TextBlock [ Grid.Column = 0, Text = $Path, Style = @Code, Foreground = @StateDangerInk, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 1, Text = $Message, Foreground = @StateDangerInk, TextWrapping = Wrap, VerticalAlignment = Center ]
        }
    }

    DataTemplate x:key="ConfigurationApplyRowTemplate" [ DataType = ConfigurationApplyRowViewModel ] {
        Grid [ Style = @TenantTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            StackPanel [ Grid.Column = 0, Orientation = Vertical, VerticalAlignment = Center ] {
                TextBlock [ Text = $VersionText, Style = @UiLabel, Foreground = @Fg0 ]
                TextBlock [ Text = $Environment, Foreground = @Fg1 ]
            }
            TextBlock [ Grid.Column = 1, Text = $OutcomeText, Foreground = @Fg1, VerticalAlignment = Center ]
            StackPanel [ Grid.Column = 2, Orientation = Vertical, VerticalAlignment = Center ] {
                TextBlock [ Text = $RequestedBy, Foreground = @Fg1 ]
                TextBlock [ Text = $RequestedText, Style = @UiCaption, Foreground = @Fg2 ]
            }
            TextBlock [ Grid.Column = 3, Text = $DetailText, Foreground = @Fg2, TextWrapping = Wrap, VerticalAlignment = Center ]
        }
    }
}
