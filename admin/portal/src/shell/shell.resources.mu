// shell.resources.mu - the shell's own views.
//
// The header: EditorShell's HeaderContent is a ContentControl whose Content is
// the PortalSessionService, rendered through this implicit-by-type template.
// It shows who is signed in, their role, the Observer read-only notice
// (collapsed for Operators) and Log out; a failed logout reports here.
//
// Shared section views: the name-to-confirm dialog every irreversible action
// opens (rendered inside the shell's DialogService surface; its buttons live
// here because a DialogAction can't follow validation), and the observed,
// read-only environments panel tenant and hive details show.
//
// PortalTable: the ListBox template every section table uses. The stock
// template's ScrollViewer scrolls both axes, so rows are measured at infinite
// width and star-sized row Grids collapse to their content; this one scrolls
// vertically only, so each row spans the table and its columns line up with
// the header Grid above it.

import PortalSessionService from "./portal-session-service.js"
import NameConfirmDialogViewModel from "./name-confirm-dialog-view-model.js"
import ObservedEnvironmentsViewModel from "./observed-environments-view-model.js"
import ObservedEnvironmentRowViewModel from "./observed-environments-view-model.js"

resources ShellResources {
    Template x:key="PortalTable" [ TargetType = ListBox ] {
        ScrollViewer x:name="PART_Scroll" [ HorizontalScrollEnabled = false ] {
            ItemsPresenter
        }
    }

    DataTemplate [ DataType = PortalSessionService ] {
        Border [ Fill = @Bg0, Stroke = Pen [ Brush = @Border ], Padding = (16,8,16,8) ] {
            DockPanel {
                Button [ DockPanel.Dock = Right, Variant = Text, Command = $LogoutCommand, Margin = (12,0,0,0) ] {
                    TextBlock [ Text = "Log out" ]
                }
                StackPanel [ DockPanel.Dock = Right, Orientation = Horizontal, VerticalAlignment = Center ] {
                    TextBlock [ Text = $Email, Style = @UiLabel, Foreground = @Fg0, Margin = (0,0,8,0) ]
                    TextBlock [ Text = $RoleLabel, Style = @UiCaption, Foreground = @Fg2 ]
                }
                StackPanel [ Orientation = Horizontal, VerticalAlignment = Center ] {
                    TextBlock [ Text = "Platform Admin", Style = @UiLabel, Foreground = @Fg0, Margin = (0,0,16,0) ]
                    TextBlock [ Text = $ReadOnlyNotice, Style = @UiCaption, Foreground = @StateWarningInk,
                                Margin = (0,0,16,0), Visibility = $ReadOnlyNotice << ToVisibility ]
                    TextBlock [ Text = $LogoutError, Style = @UiCaption, Foreground = @StateDangerInk,
                                Visibility = $LogoutError << ToVisibility ]
                }
            }
        }
    }

    // Type the target's name to confirm an irreversible action.
    DataTemplate [ DataType = NameConfirmDialogViewModel ] {
        StackPanel [ Orientation = Vertical, Margin = (0,4,0,0) ] {
            TextBlock [ Text = $Message, TextWrapping = Wrap, Foreground = @Fg1, Margin = (0,0,0,12) ]
            TextBlock [ Text = $PromptText, Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ Text = $Typed, Placeholder = $Expected, Margin = (0,0,0,12) ]
            TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,0,0,12),
                        Visibility = $ErrorText << ToVisibility ]
            StackPanel [ Orientation = Horizontal, HorizontalAlignment = Right ] {
                Button [ Variant = Secondary, Command = $CancelCommand, Margin = (0,0,8,0) ] {
                    TextBlock [ Text = "Cancel" ]
                }
                Button [ Variant = Danger, Command = $ConfirmCommand ] {
                    TextBlock [ Text = $ConfirmLabel ]
                }
            }
        }
    }

    // The observed environments: what the hive last reported, read-only.
    // Platform Admin only observes tenant data, so this panel has no commands.
    DataTemplate [ DataType = ObservedEnvironmentsViewModel ] {
        Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10) ] {
            StackPanel [ Orientation = Vertical ] {
                StackPanel [ Orientation = Horizontal, Margin = (0,0,0,8) ] {
                    TextBlock [ Text = "Environments", Style = @UiLabel, Foreground = @Fg0, Margin = (0,0,8,0) ]
                    TextBlock [ Text = "Observed - read-only", Style = @UiCaption, Foreground = @Fg2, VerticalAlignment = Center ]
                }
                TextBlock [ Text = "The hive reports no environments yet.", Foreground = @Fg2,
                            Visibility = $IsEmpty << ToVisibility ]
                StackPanel [ Orientation = Vertical, Visibility = $HasRows << ToVisibility ] {
                    Grid [ Margin = (4,0,4,4) ] {
                        ColumnDefinitions {
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                        }
                        TextBlock [ Grid.Column = 0, Text = "Environment", Style = @UiCaption, Foreground = @Fg2 ]
                        TextBlock [ Grid.Column = 1, Text = "Status", Style = @UiCaption, Foreground = @Fg2 ]
                        TextBlock [ Grid.Column = 2, Text = "Image", Style = @UiCaption, Foreground = @Fg2 ]
                        TextBlock [ Grid.Column = 3, Text = "Detail", Style = @UiCaption, Foreground = @Fg2 ]
                    }
                    ItemsControl [ ItemsSource = $Rows ]
                }
            }
        }
    }

    DataTemplate [ DataType = ObservedEnvironmentRowViewModel ] {
        Grid [ Margin = (4,2,4,2) ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            TextBlock [ Grid.Column = 0, Text = $Name, Style = @UiLabel, Foreground = @Fg0 ]
            TextBlock [ Grid.Column = 1, Text = $StatusLabel, Foreground = @Fg1 ]
            TextBlock [ Grid.Column = 2, Text = $Image, Foreground = @Fg2 ]
            TextBlock [ Grid.Column = 3, Text = $Detail, Foreground = @Fg2, TextWrapping = Wrap ]
        }
    }
}
