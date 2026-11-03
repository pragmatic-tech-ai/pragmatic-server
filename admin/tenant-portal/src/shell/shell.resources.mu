// shell.resources.mu - the shell's shared views and styles.
//
// Shared dialogs: the name-to-confirm dialog every irreversible action opens
// and the plain confirm (with consequences and an optional warning) for
// disruptive ones. Both render inside the shell's DialogService surface; their
// buttons live here because a DialogAction can't follow validation. The
// header's change-password dialog lives here too: current, new and confirm,
// all masked native password inputs; why Confirm is still off shows under the
// field at fault.
//
// TenantTable: the ListBox template every section table uses. The stock
// template's ScrollViewer scrolls both axes, so rows are measured at infinite
// width and star-sized row Grids collapse to their content; this one does not
// scroll at all (the page's own ScrollViewer scrolls header and rows
// together), so each row spans the table and its columns line up with the
// header Grid above it. TenantTableList (the style tables set) adds
// TenantTableRow, a row container without the stock row's content padding,
// and TenantTableColumns is the one inset both header and row Grids use.
//
// The side pane is hidden (TenantNavigationService), but the shell still
// renders the active section service there; the empty template for
// TenantSectionService keeps the "can not resolve template" diagnostic away.

import TenantSectionService from "./tenant-section-service.js"
import NameConfirmDialogViewModel from "./name-confirm-dialog-view-model.js"
import ConfirmDialogViewModel from "./confirm-dialog-view-model.js"
import ChangePasswordDialogViewModel from "./change-password-dialog-view-model.js"

resources ShellResources {
    DataTemplate [ DataType = TenantSectionService ] {
        Border { }
    }

    Template x:key="TenantTable" [ TargetType = ListBox ] {
        ScrollViewer x:name="PART_Scroll" [ HorizontalScrollEnabled = false, VerticalScrollEnabled = false ] {
            ItemsPresenter
        }
    }

    // A table row: the stock row's hover / selected / focus chrome with no
    // content padding, so a row's cell Grid spans exactly the table's width.
    Template x:key="TenantTableRowTemplate" [ TargetType = ListBoxItem ] {
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

    Style x:key="TenantTableRow" [ TargetType = ListBoxItem ] {
        Template = @TenantTableRowTemplate;
        TextBlock.Foreground = @Fg1;
    }

    // Every section table and list: Style = @TenantTableList on the ListBox.
    Style x:key="TenantTableList" [ TargetType = ListBox ] {
        Template = @TenantTable;
        ItemContainerStyle = @TenantTableRow;
    }

    // The one cell inset every table's header Grid and row Grid share
    // (Style = @TenantTableColumns), so their Star columns line up.
    Style x:key="TenantTableColumns" [ TargetType = Grid ] {
        Margin = (8,4,8,4);
    }

    // A table's header caption: the UiCaption face in the muted Fg2 ink.
    Style x:key="TenantTableHeader" [ TargetType = TextBlock, BasedOn = @UiCaption ] {
        Foreground = @Fg2;
    }

    // The header caption over a column whose rows hold a Ghost link button.
    // The button's template pads its text by 16 plus the 2 focus-ring offset,
    // so this caption is inset 18 to line up with the link's text.
    Style x:key="TenantTableLinkHeader" [ TargetType = TextBlock, BasedOn = @TenantTableHeader ] {
        Margin = (18,0,0,0);
    }

    // A page section's caption (an H-level label over a block of content).
    Style x:key="TenantSectionCaption" [ TargetType = TextBlock, BasedOn = @UiLabel ] {
        Foreground = @Fg0;
        Margin = (0,0,0,6);
    }

    // A bordered panel holding one section of a page.
    Style x:key="TenantPanel" [ TargetType = Border ] {
        Fill = @Bg1;
        Stroke = Pen [ Brush = @Border ];
        Padding = (12,10,12,10);
        Margin = (0,0,0,16);
    }

    // A key in a key / value list.
    Style x:key="TenantKey" [ TargetType = TextBlock, BasedOn = @UiCaption ] {
        Foreground = @Fg2;
    }

    // Type the target's name to confirm an irreversible action.
    DataTemplate [ DataType = NameConfirmDialogViewModel ] {
        StackPanel [ Orientation = Vertical, Margin = (0,4,0,0) ] {
            TextBlock [ Text = $Message, TextWrapping = Wrap, Foreground = @Fg1, Margin = (0,0,0,8) ]
            TextBlock [ Text = $ConsequencesText, TextWrapping = Wrap, Foreground = @Fg2, Margin = (0,0,0,12),
                        Visibility = $ConsequencesText << ToVisibility ]
            TextBlock [ Text = $PromptText, Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ UsesNativeInput = true, Text = $Typed, Placeholder = $Expected, Margin = (0,0,0,12) ]
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

    // Change your own password. Every box is a masked native password input.
    DataTemplate [ DataType = ChangePasswordDialogViewModel ] {
        StackPanel [ Orientation = Vertical, Margin = (0,4,0,0) ] {
            TextBlock [ Text = "Your other sessions will be signed out. This one stays signed in.", TextWrapping = Wrap,
                        Foreground = @Fg1, Margin = (0,0,0,12) ]
            TextBlock [ Text = "Current password", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ UsesNativeInput = true, InputPurpose = CurrentPassword, IsPassword = true, Text = $CurrentPassword, Margin = (0,0,0,12) ]
            TextBlock [ Text = "New password", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            StackPanel [ Orientation = Vertical, Margin = (0,0,0,12) ] {
                TextBox [ UsesNativeInput = true, InputPurpose = NewPassword, IsPassword = true, Text = $NewPassword ]
                TextBlock [ Text = $NewPasswordText, Style = @UiCaption, Foreground = @StateDangerInk, Margin = (0,4,0,0),
                            Visibility = $NewPasswordText << ToVisibility ]
            }
            TextBlock [ Text = "Confirm new password", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            StackPanel [ Orientation = Vertical, Margin = (0,0,0,12) ] {
                TextBox [ UsesNativeInput = true, InputPurpose = NewPassword, IsPassword = true, Text = $ConfirmPassword ]
                TextBlock [ Text = $MismatchText, Style = @UiCaption, Foreground = @StateDangerInk, Margin = (0,4,0,0),
                            Visibility = $MismatchText << ToVisibility ]
            }
            TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,0,0,12),
                        Visibility = $ErrorText << ToVisibility ]
            StackPanel [ Orientation = Horizontal, HorizontalAlignment = Right ] {
                Button [ Variant = Secondary, Command = $CancelCommand, Margin = (0,0,8,0) ] {
                    TextBlock [ Text = "Cancel" ]
                }
                Button [ Variant = Primary, Command = $ConfirmCommand ] {
                    TextBlock [ Text = "Change password" ]
                }
            }
        }
    }

    // A plain confirm for a disruptive action; the warning (when set) flags a
    // self-affecting one (it can lock the signed-in user out).
    DataTemplate [ DataType = ConfirmDialogViewModel ] {
        StackPanel [ Orientation = Vertical, Margin = (0,4,0,0) ] {
            TextBlock [ Text = $Message, TextWrapping = Wrap, Foreground = @Fg1, Margin = (0,0,0,8) ]
            TextBlock [ Text = $ConsequencesText, TextWrapping = Wrap, Foreground = @Fg2, Margin = (0,0,0,12),
                        Visibility = $ConsequencesText << ToVisibility ]
            Border [ Fill = @StateWarningSoft, Padding = (12,8,12,8), Margin = (0,0,0,12),
                     Visibility = $Warning << ToVisibility ] {
                TextBlock [ Text = $Warning, Foreground = @StateWarningInk, TextWrapping = Wrap ]
            }
            TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,0,0,12),
                        Visibility = $ErrorText << ToVisibility ]
            StackPanel [ Orientation = Horizontal, HorizontalAlignment = Right ] {
                Button [ Variant = Secondary, Command = $CancelCommand, Margin = (0,0,8,0) ] {
                    TextBlock [ Text = "Cancel" ]
                }
                Button [ Variant = Danger, Command = $ConfirmCommand, Visibility = $IsDanger << ToVisibility ] {
                    TextBlock [ Text = $ConfirmLabel ]
                }
                Button [ Variant = Primary, Command = $ConfirmCommand, Visibility = $IsNotDanger << ToVisibility ] {
                    TextBlock [ Text = $ConfirmLabel ]
                }
            }
        }
    }
}
