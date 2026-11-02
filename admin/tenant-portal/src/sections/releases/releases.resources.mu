// releases.resources.mu - the Releases section's views.
//
// ReleasesPageViewModel and AdoptWizardPageViewModel are presented full-width
// in the shell's content region, matched implicitly by type. The adopt
// wizard is a page, not a dialog: its step indicator, Back / Next / Cancel
// and Adopt live inside the page.
//
// Every list uses a keyed row template set as the ListBox's ItemTemplate (a
// ListBox resolves implicit-by-type templates only for MuralBase items, and
// the rows are Observables). The what-runs-where matrix has a data-driven
// column per version: the header and every environment row put their cells
// in a one-row UniformGrid inside the same Star column, so equal-width cells
// line up from row to row.

import ReleasesPageViewModel from "./releases-page-view-model.js"
import OfferRowViewModel from "./releases-page-view-model.js"
import MatrixHeaderCellViewModel from "./releases-page-view-model.js"
import MatrixRowViewModel from "./releases-page-view-model.js"
import MatrixCellViewModel from "./releases-page-view-model.js"
import LedgerRowViewModel from "./releases-page-view-model.js"
import AdoptWizardPageViewModel from "./adopt-wizard-page-view-model.js"
import AdoptStepViewModel from "./adopt-wizard-page-view-model.js"
import AdoptEnvironmentRowViewModel from "./adopt-wizard-page-view-model.js"

resources ReleasesResources {
    // An offered version as a card, with Adopt... on the right.
    DataTemplate x:key="ReleasesOfferTemplate" [ DataType = OfferRowViewModel ] {
        Border [ Style = @TenantPanel, Margin = (0,0,0,8) ] {
            DockPanel {
                Button [ DockPanel.Dock = Right, Variant = Primary, Command = $AdoptCommand, VerticalAlignment = Top, Margin = (12,0,0,0) ] {
                    TextBlock [ Text = "Adopt..." ]
                }
                StackPanel [ Orientation = Vertical ] {
                    StackPanel [ Orientation = Horizontal ] {
                        TextBlock [ Text = $Version, Style = @UiLabel, Foreground = @Fg0, Margin = (0,0,12,0) ]
                        TextBlock [ Text = $PublishedText, Style = @UiCaption, Foreground = @Fg2, VerticalAlignment = Center ]
                    }
                    TextBlock [ Text = $Notes, Foreground = @Fg1, TextWrapping = Wrap, Margin = (0,4,0,0),
                                Visibility = $HasNotes << ToVisibility ]
                    TextBlock [ Text = $NotOnText, Style = @UiCaption, Foreground = @Fg2, Margin = (0,4,0,0) ]
                }
            }
        }
    }

    // The matrix's cells sit in one row of equal-width columns.
    ItemsPanelTemplate x:key="ReleasesMatrixCellsPanel" {
        UniformGrid [ Rows = 1 ]
    }

    DataTemplate x:key="ReleasesMatrixHeaderCellTemplate" [ DataType = MatrixHeaderCellViewModel ] {
        TextBlock [ Text = $Label, Style = @TenantTableHeader, HorizontalAlignment = Center ]
    }

    DataTemplate x:key="ReleasesMatrixCellTemplate" [ DataType = MatrixCellViewModel ] {
        StackPanel [ Orientation = Horizontal, HorizontalAlignment = Center ] {
            Border [ Fill = @StateSuccessSoft, Padding = (8,2,8,2), Visibility = $IsRunning << ToVisibility ] {
                TextBlock [ Text = $Text, Style = @UiCaption, Foreground = @StateSuccessInk ]
            }
            TextBlock [ Text = $Text, Foreground = @Fg2, Visibility = $IsNotRunning << ToVisibility ]
        }
    }

    DataTemplate x:key="ReleasesMatrixRowTemplate" [ DataType = MatrixRowViewModel ] {
        Grid [ Style = @TenantTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            TextBlock [ Grid.Column = 0, Text = $Name, Style = @UiLabel, Foreground = @Fg0, VerticalAlignment = Center ]
            ListBox [ Grid.Column = 1, Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $Cells,
                      ItemsPanel = @ReleasesMatrixCellsPanel, ItemTemplate = @ReleasesMatrixCellTemplate ]
        }
    }

    DataTemplate x:key="ReleasesLedgerRowTemplate" [ DataType = LedgerRowViewModel ] {
        Grid [ Style = @TenantTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            TextBlock [ Grid.Column = 0, Text = $Version, Style = @Code, Foreground = @Fg0 ]
            TextBlock [ Grid.Column = 1, Text = $ActionLabel, Foreground = @Fg1 ]
            TextBlock [ Grid.Column = 2, Text = $WhenLabel, Foreground = @Fg2 ]
        }
    }

    DataTemplate [ DataType = ReleasesPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Margin = (0,0,0,16) ] {
                TextBlock [ Text = "Releases", Style = @H3, Foreground = @Fg0 ]
                TextBlock [ Text = "Versions Pragmatic has offered to your hive. Adopting is always your choice.",
                            Style = @Body, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,4,0,0) ]
                TextBlock [ Text = $DeniedReason, Style = @UiCaption, Foreground = @StateWarningInk, Margin = (0,4,0,0),
                            Visibility = $DeniedReason << ToVisibility ]
                TextBlock [ Text = $CommandErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,4,0,0),
                            Visibility = $CommandErrorText << ToVisibility ]
            }

            TextBlock [ DockPanel.Dock = Top, Text = "Loading releases...", Foreground = @Fg2,
                        Visibility = $IsLoading << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = $EmptyText, Foreground = @Fg2, TextWrapping = Wrap,
                        Visibility = $IsEmpty << ToVisibility ]
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsError << ToVisibility ] {
                TextBlock [ Text = "Could not load the releases.", Foreground = @StateDangerInk ]
                TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap ]
            }
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsDenied << ToVisibility ] {
                TextBlock [ Text = "You don't have access to the releases", Style = @UiLabel, Foreground = @Fg0 ]
                StackPanel [ Orientation = Horizontal, Margin = (0,4,0,0) ] {
                    TextBlock [ Text = "This needs access to your hive. Ask", Foreground = @Fg2, Margin = (0,0,4,0) ]
                    TextBlock [ Text = $OwnerContact, Foreground = @Fg1 ]
                }
            }

            ScrollViewer [ HorizontalScrollEnabled = false, Visibility = $IsPopulated << ToVisibility ] {
                StackPanel [ Orientation = Vertical ] {
                    // The offers, newest first.
                    TextBlock [ Text = "Offered versions", Style = @TenantSectionCaption ]
                    ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $Offers,
                              ItemTemplate = @ReleasesOfferTemplate, Margin = (0,0,0,8) ]

                    // Environment x version.
                    StackPanel [ Orientation = Vertical, Visibility = $HasMatrix << ToVisibility ] {
                        TextBlock [ Text = "Which environment runs what", Style = @TenantSectionCaption ]
                        Border [ Style = @TenantPanel ] {
                            StackPanel [ Orientation = Vertical ] {
                                Grid [ Style = @TenantTableColumns ] {
                                    ColumnDefinitions {
                                        ColumnDefinition [ Width = GridLength.Star ]
                                        ColumnDefinition [ Width = GridLength.Star ]
                                    }
                                    TextBlock [ Grid.Column = 0, Text = "Environment", Style = @TenantTableHeader ]
                                    ListBox [ Grid.Column = 1, Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $MatrixHeader,
                                              ItemsPanel = @ReleasesMatrixCellsPanel, ItemTemplate = @ReleasesMatrixHeaderCellTemplate ]
                                }
                                ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $MatrixRows,
                                          ItemTemplate = @ReleasesMatrixRowTemplate ]
                            }
                        }
                    }

                    // The hive's adoption ledger, newest first.
                    TextBlock [ Text = "Version history", Style = @TenantSectionCaption ]
                    Border [ Style = @TenantPanel ] {
                        StackPanel [ Orientation = Vertical ] {
                            TextBlock [ Text = "No version history yet.", Foreground = @Fg2, Visibility = $HasNoLedger << ToVisibility ]
                            StackPanel [ Orientation = Vertical, Visibility = $HasLedger << ToVisibility ] {
                                Grid [ Style = @TenantTableColumns ] {
                                    ColumnDefinitions {
                                        ColumnDefinition [ Width = GridLength.Star ]
                                        ColumnDefinition [ Width = GridLength.Star ]
                                        ColumnDefinition [ Width = GridLength.Star ]
                                    }
                                    TextBlock [ Grid.Column = 0, Text = "Version", Style = @TenantTableHeader ]
                                    TextBlock [ Grid.Column = 1, Text = "Action", Style = @TenantTableHeader ]
                                    TextBlock [ Grid.Column = 2, Text = "When", Style = @TenantTableHeader ]
                                }
                                ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $LedgerRows,
                                          ItemTemplate = @ReleasesLedgerRowTemplate ]
                            }
                        }
                    }
                }
            }
        }
    }

    // The wizard's step indicator lays its steps out in a row.
    ItemsPanelTemplate x:key="AdoptStepsPanel" {
        StackPanel [ Orientation = Horizontal ]
    }

    // One step of the indicator: its number and label, emphasised when current.
    DataTemplate x:key="AdoptStepTemplate" [ DataType = AdoptStepViewModel ] {
        StackPanel [ Orientation = Horizontal, Margin = (0,0,20,0) ] {
            Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (8,2,8,2), Margin = (0,0,6,0) ] {
                TextBlock [ Text = $NumberText, Style = @UiCaption, Foreground = @Fg1 ]
            }
            TextBlock [ Text = $Label, Style = @UiLabel, Foreground = @Fg0, VerticalAlignment = Center,
                        Visibility = $IsCurrent << ToVisibility ]
            TextBlock [ Text = $Label, Foreground = @Fg2, VerticalAlignment = Center,
                        Visibility = $IsNotCurrent << ToVisibility ]
        }
    }

    DataTemplate x:key="AdoptEnvironmentRowTemplate" [ DataType = AdoptEnvironmentRowViewModel ] {
        Grid [ Style = @TenantTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            TextBlock [ Grid.Column = 0, Text = $Name, Style = @UiLabel, Foreground = @Fg0 ]
            TextBlock [ Grid.Column = 1, Text = $Label, Foreground = @Fg1 ]
        }
    }

    // Adopt a version: Version, Environments, Review, Outcome.
    DataTemplate [ DataType = AdoptWizardPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Margin = (0,0,0,16) ] {
                TextBlock [ Text = "Adopt a version", Style = @H3, Foreground = @Fg0 ]
                TextBlock [ Text = "Pragmatic offers versions; you choose when your hive moves to one.",
                            Style = @Body, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,4,0,0) ]
                TextBlock [ Text = $DeniedReason, Style = @UiCaption, Foreground = @StateWarningInk, Margin = (0,4,0,0),
                            Visibility = $DeniedReason << ToVisibility ]
            }

            TextBlock [ DockPanel.Dock = Top, Text = "Loading the offered versions...", Foreground = @Fg2,
                        Visibility = $IsLoading << ToVisibility ]
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsEmpty << ToVisibility ] {
                TextBlock [ Text = $EmptyText, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,0,0,12) ]
                Button [ Variant = Secondary, Command = $CancelCommand, HorizontalAlignment = Left ] {
                    TextBlock [ Text = "Back to releases" ]
                }
            }
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsError << ToVisibility ] {
                TextBlock [ Text = "Could not load the offered versions.", Foreground = @StateDangerInk ]
                TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,0,0,12) ]
                Button [ Variant = Secondary, Command = $CancelCommand, HorizontalAlignment = Left ] {
                    TextBlock [ Text = "Back to releases" ]
                }
            }
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsDenied << ToVisibility ] {
                TextBlock [ Text = "You don't have access to the releases", Style = @UiLabel, Foreground = @Fg0 ]
                StackPanel [ Orientation = Horizontal, Margin = (0,4,0,0) ] {
                    TextBlock [ Text = "This needs access to your hive. Ask", Foreground = @Fg2, Margin = (0,0,4,0) ]
                    TextBlock [ Text = $OwnerContact, Foreground = @Fg1 ]
                }
            }

            DockPanel [ Visibility = $IsPopulated << ToVisibility ] {
                // Step indicator.
                ItemsControl [ DockPanel.Dock = Top, ItemsSource = $Steps, ItemsPanel = @AdoptStepsPanel,
                               ItemTemplate = @AdoptStepTemplate, Margin = (0,0,0,20) ]

                // Footer: Cancel and Back on the left; Next or Adopt on the right.
                DockPanel [ DockPanel.Dock = Bottom, Margin = (0,16,0,0), Visibility = $IsFormStep << ToVisibility ] {
                    Button [ DockPanel.Dock = Right, Variant = Primary, Command = $NextCommand,
                             Visibility = $IsChoiceStep << ToVisibility ] {
                        TextBlock [ Text = "Next" ]
                    }
                    Button [ DockPanel.Dock = Right, Variant = Primary, Command = $AdoptCommand,
                             Visibility = $IsReviewStep << ToVisibility ] {
                        TextBlock [ Text = $AdoptLabel ]
                    }
                    StackPanel [ Orientation = Horizontal ] {
                        Button [ Variant = Secondary, Command = $CancelCommand, Margin = (0,0,8,0) ] {
                            TextBlock [ Text = "Cancel" ]
                        }
                        Button [ Variant = Secondary, Command = $BackStepCommand ] {
                            TextBlock [ Text = "Back" ]
                        }
                    }
                }

                ScrollViewer [ HorizontalScrollEnabled = false ] {
                    StackPanel [ Orientation = Vertical ] {
                        // Step 1: the version.
                        StackPanel [ Orientation = Vertical, Visibility = $IsVersionStep << ToVisibility ] {
                            TextBlock [ Text = "Choose a version", Style = @UiLabel, Foreground = @Fg0, Margin = (0,0,0,4) ]
                            TextBlock [ Text = "These are the versions your hive may adopt.",
                                        Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,12) ]
                            TextBlock [ Text = "Version", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                            ComboBox [ ItemsSource = $Versions, SelectedItem = $SelectedVersion, HorizontalAlignment = Stretch, Margin = (0,0,0,12) ]
                            TextBlock [ Text = $PublishedText, Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                            TextBlock [ Text = $Notes, Foreground = @Fg1, TextWrapping = Wrap, Visibility = $Notes << ToVisibility ]
                        }

                        // Step 2: what happens to each environment (informational).
                        StackPanel [ Orientation = Vertical, Visibility = $IsEnvironmentsStep << ToVisibility ] {
                            TextBlock [ Text = "Your environments", Style = @UiLabel, Foreground = @Fg0, Margin = (0,0,0,4) ]
                            TextBlock [ Text = "Adopting applies to the whole hive: every environment on it moves to this version.",
                                        Style = @UiCaption, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,0,0,12) ]
                            TextBlock [ Text = "No environments are bound to this hive yet.", Foreground = @Fg2,
                                        Visibility = $HasNoEnvironments << ToVisibility ]
                            Border [ Style = @TenantPanel, Visibility = $HasEnvironments << ToVisibility ] {
                                ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $Environments,
                                          ItemTemplate = @AdoptEnvironmentRowTemplate ]
                            }
                        }

                        // Step 3: the impact, then Adopt.
                        StackPanel [ Orientation = Vertical, Visibility = $IsReviewStep << ToVisibility ] {
                            TextBlock [ Text = "Review", Style = @UiLabel, Foreground = @Fg0, Margin = (0,0,0,4) ]
                            Border [ Style = @TenantPanel ] {
                                StackPanel [ Orientation = Vertical ] {
                                    StackPanel [ Orientation = Horizontal, Margin = (0,0,0,6) ] {
                                        TextBlock [ Text = "Version", Style = @TenantKey, Margin = (0,0,8,0), VerticalAlignment = Center ]
                                        TextBlock [ Text = $VersionText, Style = @Code, Foreground = @Fg0 ]
                                    }
                                    TextBlock [ Text = $ImpactText, Foreground = @Fg1, TextWrapping = Wrap ]
                                }
                            }
                            Border [ Fill = @StateInfoSoft, Padding = (12,8,12,8), Margin = (0,0,0,12) ] {
                                TextBlock [ Text = "If a new version fails verification, your environment keeps serving the version it runs now.",
                                            Foreground = @Fg1, TextWrapping = Wrap ]
                            }
                            TextBlock [ Text = "Adopting...", Foreground = @Fg2, Visibility = $IsSubmitting << ToVisibility ]
                            TextBlock [ Text = $CommandErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap,
                                        Visibility = $CommandErrorText << ToVisibility ]
                        }

                        // Step 4: what the server answered.
                        StackPanel [ Orientation = Vertical, Visibility = $IsOutcomeStep << ToVisibility ] {
                            Border [ Fill = @StateSuccessSoft, Padding = (12,10,12,10), Margin = (0,0,0,12),
                                     Visibility = $IsAdopted << ToVisibility ] {
                                TextBlock [ Text = $OutcomeTitle, Foreground = @StateSuccessInk, TextWrapping = Wrap ]
                            }
                            Border [ Fill = @StateDangerSoft, Padding = (12,10,12,10), Margin = (0,0,0,12),
                                     Visibility = $IsNotAdopted << ToVisibility ] {
                                StackPanel [ Orientation = Vertical ] {
                                    TextBlock [ Text = $OutcomeTitle, Foreground = @StateDangerInk ]
                                    TextBlock [ Text = $OutcomeMessage, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,4,0,0),
                                                Visibility = $OutcomeMessage << ToVisibility ]
                                }
                            }
                            StackPanel [ Orientation = Horizontal ] {
                                Button [ Variant = Primary, Command = $BackToReleasesCommand, Margin = (0,0,8,0) ] {
                                    TextBlock [ Text = "Back to releases" ]
                                }
                                Button [ Variant = Secondary, Command = $BackToEnvironmentsCommand ] {
                                    TextBlock [ Text = "Back to environments" ]
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
