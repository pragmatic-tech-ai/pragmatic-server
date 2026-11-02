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
// the header Grid above it. PortalTableList (the style tables set) adds
// PortalTableRow, a row container without the stock row's content padding,
// and PortalTableColumns is the one inset both header and row Grids use.

import PortalSessionService from "./portal-session-service.js"
import NameConfirmDialogViewModel from "./name-confirm-dialog-view-model.js"
import ObservedEnvironmentsViewModel from "./observed-environments-view-model.js"
import ObservedEnvironmentRowViewModel from "./observed-environments-view-model.js"

resources ShellResources {
    // The table never scrolls by itself (a scroll bar would take a gutter
    // from the rows but not from the header above them): the page's own
    // ScrollViewer scrolls header and rows together.
    Template x:key="PortalTable" [ TargetType = ListBox ] {
        ScrollViewer x:name="PART_Scroll" [ HorizontalScrollEnabled = false, VerticalScrollEnabled = false ] {
            ItemsPresenter
        }
    }

    // A table row: the stock row's hover / selected / focus chrome with no
    // content padding, so a row's cell Grid spans exactly the table's width.
    Template x:key="PortalTableRowTemplate" [ TargetType = ListBoxItem ] {
        Border x:name="PART_FocusRing" [ Fill = #00000000, CornerRadius = @RadiusMd ] {
            Border x:name="PART_Border" [ Fill = #00000000, CornerRadius = @RadiusMd ] {
                Border x:name="PART_Selected" [ Fill = #00000000, CornerRadius = @RadiusMd ] {
                    ContentPresenter x:name="PART_HeadlineSlot" [ HorizontalAlignment = Stretch ]
                }
            }
        }
        when ( IsSelected ) { PART_Selected.Fill = @SurfaceSelected; }
        when ( IsMouseOver ) { PART_Border.Fill = @RowHoverFill; }
        when ( IsFocused ) { PART_FocusRing.Stroke = Pen [ Brush = @BorderFocus, Thickness = 2 ]; }
    }

    Style x:key="PortalTableRow" [ TargetType = ListBoxItem ] {
        Template = @PortalTableRowTemplate;
        TextBlock.Foreground = @Fg1;
    }

    // Every section table: Style = @PortalTableList on the ListBox.
    Style x:key="PortalTableList" [ TargetType = ListBox ] {
        Template = @PortalTable;
        ItemContainerStyle = @PortalTableRow;
    }

    // The one cell inset every table's header Grid and row Grid share
    // (Style = @PortalTableColumns), so their Star columns line up.
    Style x:key="PortalTableColumns" [ TargetType = Grid ] {
        Margin = (8,4,8,4);
    }

    // A table's header caption: the UiCaption face in the muted Fg2 ink.
    Style x:key="PortalTableHeader" [ TargetType = TextBlock, BasedOn = @UiCaption ] {
        Foreground = @Fg2;
    }

    // The header caption over a column whose rows hold a Ghost link button
    // (the row's name / action). The button's template pads its text by 16
    // plus the 2 focus-ring offset, so this caption is inset 18 to line up
    // with the link's text. The one home of that number.
    Style x:key="PortalTableLinkHeader" [ TargetType = TextBlock, BasedOn = @PortalTableHeader ] {
        Margin = (18,0,0,0);
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
            // The reason, when the action records one (a withdrawal).
            StackPanel [ Orientation = Vertical, Visibility = $RequiresReason << ToVisibility ] {
                TextBlock [ Text = $ReasonLabel, Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                TextBox [ Text = $Reason, Margin = (0,0,0,12) ]
            }
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
                        TextBlock [ Grid.Column = 0, Text = "Environment", Style = @PortalTableHeader ]
                        TextBlock [ Grid.Column = 1, Text = "Status", Style = @PortalTableHeader ]
                        TextBlock [ Grid.Column = 2, Text = "Image", Style = @PortalTableHeader ]
                        TextBlock [ Grid.Column = 3, Text = "Detail", Style = @PortalTableHeader ]
                    }
                    ListBox [ Style = @PortalTableList, HorizontalAlignment = Stretch, ItemsSource = $Rows, ItemTemplate = @ObservedEnvironmentRowTemplate ]
                }
            }
        }
    }

    DataTemplate x:key="ObservedEnvironmentRowTemplate" [ DataType = ObservedEnvironmentRowViewModel ] {
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
