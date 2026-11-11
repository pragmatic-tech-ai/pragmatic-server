// security-model.resources.mu - the Roles & permissions tab: the security-setting
// editor for the environment the Users & Access page selected. Merged by
// UsersAccessModule. Roles, concepts, secured fields and field profiles come
// from the environment's catalog; the editor stores overrides and assignments.
//
// One draft, one save bar (bottom) for the whole setting. Mode tabs Roles |
// Organization and each mode's sub-tabs are SegmentedButtons over label
// collections; each tab's content shows by a Visibility flag. Every list is a
// ListBox (Style = @TenantTableList) with an explicit keyed ItemTemplate: the
// rows are Observables, which a ListBox does not match by type. Editing
// controls bind IsEnabled to CanEdit (the Manage users & access permission):
// visible but disabled without it, with the reason shown. Text boxes bind
// two-way to row view-models; a keystroke never replaces the collection the
// box lives in. A privilege cell / assignment editor binds through a nested
// DataContext (a dotted $A.B path only re-reads on its first segment).

import SecurityModelEditorViewModel from "./security-model-editor-view-model.js"
import AssignmentEditorViewModel from "./assignment-editor-view-model.js"
import AssignmentPrincipalRowViewModel from "./assignment-editor-view-model.js"
import AssignmentTeamRowViewModel from "./assignment-editor-view-model.js"
import RoleItemViewModel from "./security-model-role-rows.js"
import ProfileItemViewModel from "./security-model-role-rows.js"
import PrivilegeRowViewModel from "./security-model-role-rows.js"
import LegendEntryViewModel from "./security-model-role-rows.js"
import FieldGrantRowViewModel from "./security-model-role-rows.js"
import BusinessUnitRowViewModel from "./security-model-org-rows.js"
import TeamRowViewModel from "./security-model-org-rows.js"
import IdpGroupRowViewModel from "./security-model-org-rows.js"
import TeamMemberRowViewModel from "./security-model-org-rows.js"
import UserPlacementRowViewModel from "./security-model-org-rows.js"

resources SecurityModelResources {
    DataTemplate [ DataType = SecurityModelEditorViewModel ] {
        DockPanel {
            TextBlock [ DockPanel.Dock = Top, Text = "Loading the security model...", Foreground = @Fg2,
                        Visibility = $IsLoading << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = "No environment to show. The security model is kept per environment.",
                        Foreground = @Fg2, Visibility = $IsEmpty << ToVisibility ]
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsError << ToVisibility ] {
                TextBlock [ Text = "Could not load the security model.", Foreground = @StateDangerInk ]
                TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap ]
            }
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsDenied << ToVisibility ] {
                TextBlock [ Text = "You don't have access to the security model", Style = @UiLabel, Foreground = @Fg0 ]
                StackPanel [ Orientation = Horizontal, Margin = (0,4,0,0) ] {
                    TextBlock [ Text = "This needs the Manage users & access permission. Ask", Foreground = @Fg2, Margin = (0,0,4,0) ]
                    TextBlock [ Text = $OwnerContact, Foreground = @Fg1 ]
                }
            }

            // The one save bar for the whole model.
            Border [ DockPanel.Dock = Bottom, Style = @TenantPanel, Margin = (0,12,0,0), Visibility = $IsPopulated << ToVisibility ] {
                StackPanel [ Orientation = Vertical ] {
                    StackPanel [ Orientation = Horizontal ] {
                        TextBlock [ Text = $SaveStateText, Style = @UiLabel, Foreground = @Fg0, VerticalAlignment = Center, Margin = (0,0,16,0) ]
                        Button [ Variant = Secondary, Command = $DiscardCommand, Margin = (0,0,8,0) ] {
                            TextBlock [ Text = "Discard" ]
                        }
                        Button [ Variant = Primary, Command = $SaveCommand ] {
                            TextBlock [ Text = "Save" ]
                        }
                    }
                    TextBlock [ Text = $CommandErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,8,0,0),
                                Visibility = $CommandErrorText << ToVisibility ]
                }
            }

            ScrollViewer [ HorizontalScrollEnabled = false, Visibility = $IsPopulated << ToVisibility ] {
                StackPanel [ Orientation = Vertical ] {
                    StackPanel [ Orientation = Horizontal, Margin = (0,0,0,12) ] {
                        SegmentedButton [ ItemsSource = $ModeLabels, SelectedItem = $SelectedMode, SelectionMode = Single, HorizontalAlignment = Left ]
                    }
                    TextBlock [ Text = $DeniedReason, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,0,0,12),
                                Visibility = $DeniedReason << ToVisibility ]

                    // ---- Roles mode ----
                    Grid [ Visibility = $IsRolesMode << ToVisibility ] {
                        ColumnDefinitions {
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                        }

                        // The role list.
                        StackPanel [ Grid.Column = 0, Orientation = Vertical, Margin = (0,0,16,0) ] {
                            TextBlock [ Text = "Roles", Style = @TenantSectionCaption ]
                            TextBlock [ Text = "This environment's catalog lists no roles yet.", Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,0,0,8),
                                        Visibility = $HasNoRoles << ToVisibility ]
                            ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $Roles,
                                      SelectedItem = $SelectedRole, ItemTemplate = @SecurityModelRoleItemTemplate,
                                      Visibility = $HasRoles << ToVisibility ]
                        }

                        // The selected role's tabs.
                        StackPanel [ Grid.Column = 1, Grid.ColumnSpan = 3, Orientation = Vertical ] {
                            TextBlock [ Text = $SelectedRoleName, Style = @H4, Foreground = @Fg0, Margin = (0,0,0,8),
                                        Visibility = $HasSelectedRole << ToVisibility ]
                            StackPanel [ Orientation = Horizontal, Margin = (0,0,0,12) ] {
                                SegmentedButton [ ItemsSource = $RoleTabLabels, SelectedItem = $SelectedRoleTab, SelectionMode = Single, HorizontalAlignment = Left ]
                            }

                            // What they can do: the privilege matrix.
                            StackPanel [ Orientation = Vertical, Visibility = $IsPrivilegesTab << ToVisibility ] {
                                TextBlock [ Text = "Select a role to edit what it can do.", Foreground = @Fg2,
                                            Visibility = $HasNoSelectedRole << ToVisibility ]
                                TextBlock [ Text = $SystemAdministratorText, Foreground = @Fg2, TextWrapping = Wrap,
                                            Visibility = $IsSystemAdministrator << ToVisibility ]
                                StackPanel [ Orientation = Vertical, Visibility = $ShowsMatrix << ToVisibility ] {
                                    Grid [ Style = @TenantTableColumns ] {
                                        ColumnDefinitions {
                                            ColumnDefinition [ Width = GridLength.Star ]
                                            ColumnDefinition [ Width = GridLength.Star ]
                                            ColumnDefinition [ Width = GridLength.Star ]
                                            ColumnDefinition [ Width = GridLength.Star ]
                                            ColumnDefinition [ Width = GridLength.Star ]
                                            ColumnDefinition [ Width = GridLength.Star ]
                                            ColumnDefinition [ Width = GridLength.Star ]
                                            ColumnDefinition [ Width = GridLength.Star ]
                                            ColumnDefinition [ Width = GridLength.Star ]
                                            ColumnDefinition [ Width = GridLength.Star ]
                                        }
                                        TextBlock [ Grid.Column = 0, Text = "Concept", Style = @TenantTableHeader ]
                                        TextBlock [ Grid.Column = 1, Text = "Create", Style = @TenantTableHeader ]
                                        TextBlock [ Grid.Column = 2, Text = "Read", Style = @TenantTableHeader ]
                                        TextBlock [ Grid.Column = 3, Text = "Update", Style = @TenantTableHeader ]
                                        TextBlock [ Grid.Column = 4, Text = "Delete", Style = @TenantTableHeader ]
                                        TextBlock [ Grid.Column = 5, Text = "Append", Style = @TenantTableHeader ]
                                        TextBlock [ Grid.Column = 6, Text = "Append to", Style = @TenantTableHeader ]
                                        TextBlock [ Grid.Column = 7, Text = "Assign", Style = @TenantTableHeader ]
                                        TextBlock [ Grid.Column = 8, Text = "Share", Style = @TenantTableHeader ]
                                        TextBlock [ Grid.Column = 9, Text = "Invoke", Style = @TenantTableHeader ]
                                    }
                                    ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $PrivilegeRows,
                                              ItemTemplate = @SecurityModelPrivilegeRowTemplate ]
                                    TextBlock [ Text = "Access levels", Style = @TenantSectionCaption, Margin = (0,16,0,4) ]
                                    ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $Legend,
                                              ItemTemplate = @SecurityModelLegendTemplate ]
                                }
                            }

                            // People: who holds the role.
                            StackPanel [ Orientation = Vertical, Visibility = $IsPeopleTab << ToVisibility ] {
                                TextBlock [ Text = "Select a role to see who holds it.", Foreground = @Fg2,
                                            Visibility = $HasNoSelectedRole << ToVisibility ]
                                StackPanel [ Orientation = Vertical, Visibility = $HasSelectedRole << ToVisibility ] {
                                    ContentControl [ Content = $RoleAssignment ]
                                }
                            }
                        }
                    }

                    // ---- Field profiles mode ----
                    Grid [ Visibility = $IsProfilesMode << ToVisibility ] {
                        ColumnDefinitions {
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                        }

                        // The profile list.
                        StackPanel [ Grid.Column = 0, Orientation = Vertical, Margin = (0,0,16,0) ] {
                            TextBlock [ Text = "Field profiles", Style = @TenantSectionCaption ]
                            TextBlock [ Text = "This environment's catalog lists no field profiles yet.", Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,0,0,8),
                                        Visibility = $HasNoSelectedProfile << ToVisibility ]
                            ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $Profiles,
                                      SelectedItem = $SelectedProfile, ItemTemplate = @SecurityModelProfileItemTemplate ]
                        }

                        // The selected profile's tabs.
                        StackPanel [ Grid.Column = 1, Grid.ColumnSpan = 3, Orientation = Vertical, Visibility = $HasSelectedProfile << ToVisibility ] {
                            StackPanel [ Orientation = Horizontal, Margin = (0,0,0,12) ] {
                                SegmentedButton [ ItemsSource = $ProfileTabLabels, SelectedItem = $SelectedProfileTab, SelectionMode = Single, HorizontalAlignment = Left ]
                            }

                            // Field access: every secured field in the catalog.
                            StackPanel [ Orientation = Vertical, Visibility = $IsFieldsTab << ToVisibility ] {
                                TextBlock [ Text = "This environment's catalog lists no secured fields.", Foreground = @Fg2, TextWrapping = Wrap,
                                            Visibility = $HasNoFieldRows << ToVisibility ]
                                Grid [ Style = @TenantTableColumns ] {
                                    ColumnDefinitions {
                                        ColumnDefinition [ Width = GridLength.Star ]
                                        ColumnDefinition [ Width = GridLength.Star ]
                                        ColumnDefinition [ Width = GridLength.Star ]
                                        ColumnDefinition [ Width = GridLength.Star ]
                                        ColumnDefinition [ Width = GridLength.Star ]
                                        ColumnDefinition [ Width = GridLength.Star ]
                                    }
                                    TextBlock [ Grid.Column = 0, Text = "Field", Style = @TenantTableHeader ]
                                    TextBlock [ Grid.Column = 1, Text = "Read", Style = @TenantTableHeader ]
                                    TextBlock [ Grid.Column = 2, Text = "Update", Style = @TenantTableHeader ]
                                    TextBlock [ Grid.Column = 3, Text = "Create", Style = @TenantTableHeader ]
                                    TextBlock [ Grid.Column = 4, Text = "Default", Style = @TenantTableHeader ]
                                }
                                ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $FieldRows,
                                          ItemTemplate = @SecurityModelFieldGrantTemplate ]
                            }

                            // People: who holds the profile.
                            StackPanel [ Orientation = Vertical, Visibility = $IsProfilePeopleTab << ToVisibility ] {
                                ContentControl [ Content = $ProfileAssignment ]
                            }
                        }
                    }

                    // ---- Changes mode (content arrives with the changes view) ----
                    StackPanel [ Orientation = Vertical, Visibility = $IsChangesMode << ToVisibility ] {
                        TextBlock [ Text = "Security changes from deliveries will be listed here.", Foreground = @Fg2, TextWrapping = Wrap ]
                    }

                    // ---- Organization mode ----
                    StackPanel [ Orientation = Vertical, Visibility = $IsOrganizationMode << ToVisibility ] {
                        StackPanel [ Orientation = Horizontal, Margin = (0,0,0,12) ] {
                            SegmentedButton [ ItemsSource = $OrgTabLabels, SelectedItem = $SelectedOrgTab, SelectionMode = Single, HorizontalAlignment = Left ]
                        }

                        // Business units.
                        StackPanel [ Orientation = Vertical, Visibility = $IsBusinessUnitsTab << ToVisibility ] {
                            TextBlock [ Text = "No business units yet. Add one to build your organization tree.", Foreground = @Fg2,
                                        Visibility = $HasNoBusinessUnits << ToVisibility ]
                            Grid [ Style = @TenantTableColumns ] {
                                ColumnDefinitions {
                                    ColumnDefinition [ Width = GridLength.Star ]
                                    ColumnDefinition [ Width = GridLength.Star ]
                                    ColumnDefinition [ Width = GridLength.Auto ]
                                }
                                TextBlock [ Grid.Column = 0, Text = "Business unit", Style = @TenantTableHeader ]
                                TextBlock [ Grid.Column = 1, Text = "Parent", Style = @TenantTableHeader ]
                            }
                            ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $BusinessUnitRows,
                                      ItemTemplate = @SecurityModelBusinessUnitTemplate ]
                            Grid [ Margin = (0,8,0,0) ] {
                                ColumnDefinitions {
                                    ColumnDefinition [ Width = GridLength.Star ]
                                    ColumnDefinition [ Width = GridLength.Auto ]
                                }
                                TextBox [ UsesNativeInput = true, Grid.Column = 0, Text = $NewBusinessUnitName, Placeholder = "New business unit name", IsEnabled = $CanEdit, Margin = (0,0,8,0) ]
                                Button [ Grid.Column = 1, Variant = Secondary, Command = $AddBusinessUnitCommand ] {
                                    TextBlock [ Text = "Add business unit" ]
                                }
                            }
                        }

                        // People.
                        StackPanel [ Orientation = Vertical, Visibility = $IsOrgPeopleTab << ToVisibility ] {
                            TextBlock [ Text = "No one is placed yet. Add a person to put them in a business unit.", Foreground = @Fg2,
                                        Visibility = $HasNoUsers << ToVisibility ]
                            Grid [ Style = @TenantTableColumns ] {
                                ColumnDefinitions {
                                    ColumnDefinition [ Width = GridLength.Star ]
                                    ColumnDefinition [ Width = GridLength.Star ]
                                    ColumnDefinition [ Width = GridLength.Auto ]
                                }
                                TextBlock [ Grid.Column = 0, Text = "Person", Style = @TenantTableHeader ]
                                TextBlock [ Grid.Column = 1, Text = "Business unit", Style = @TenantTableHeader ]
                            }
                            ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $UserRows,
                                      ItemTemplate = @SecurityModelUserPlacementTemplate ]
                            Grid [ Margin = (0,8,0,0) ] {
                                ColumnDefinitions {
                                    ColumnDefinition [ Width = GridLength.Star ]
                                    ColumnDefinition [ Width = GridLength.Auto ]
                                }
                                TextBox [ UsesNativeInput = true, Grid.Column = 0, Text = $NewUserPrincipalId, Placeholder = "Person id", IsEnabled = $CanEdit, Margin = (0,0,8,0) ]
                                Button [ Grid.Column = 1, Variant = Secondary, Command = $PlaceUserCommand ] {
                                    TextBlock [ Text = "Add person" ]
                                }
                            }
                        }

                        // Teams.
                        StackPanel [ Orientation = Vertical, Visibility = $IsTeamsTab << ToVisibility ] {
                            TextBlock [ Text = "No teams yet. Add one to group people.", Foreground = @Fg2,
                                        Visibility = $HasNoTeams << ToVisibility ]
                            Grid [ Style = @TenantTableColumns ] {
                                ColumnDefinitions {
                                    ColumnDefinition [ Width = GridLength.Star ]
                                    ColumnDefinition [ Width = GridLength.Star ]
                                    ColumnDefinition [ Width = GridLength.Auto ]
                                }
                                TextBlock [ Grid.Column = 0, Text = "Team", Style = @TenantTableHeader ]
                                TextBlock [ Grid.Column = 1, Text = "Business unit", Style = @TenantTableHeader ]
                            }
                            ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $TeamRows,
                                      ItemTemplate = @SecurityModelTeamTemplate ]
                            Grid [ Margin = (0,8,0,0) ] {
                                ColumnDefinitions {
                                    ColumnDefinition [ Width = GridLength.Star ]
                                    ColumnDefinition [ Width = GridLength.Auto ]
                                }
                                TextBox [ UsesNativeInput = true, Grid.Column = 0, Text = $NewTeamName, Placeholder = "New team name", IsEnabled = $CanEdit, Margin = (0,0,8,0) ]
                                Button [ Grid.Column = 1, Variant = Secondary, Command = $AddTeamCommand ] {
                                    TextBlock [ Text = "Add team" ]
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // ---- Roles mode rows ----

    DataTemplate x:key="SecurityModelRoleItemTemplate" [ DataType = RoleItemViewModel ] {
        TextBlock [ Text = $Label, Foreground = @Fg0, Margin = (8,6,8,6) ]
    }

    DataTemplate x:key="SecurityModelProfileItemTemplate" [ DataType = ProfileItemViewModel ] {
        TextBlock [ Text = $Label, Foreground = @Fg0, Margin = (8,6,8,6) ]
    }

    // A concept row: the concept, a level button per action (same ten
    // columns as the header), then the plain-words sentence beneath.
    DataTemplate x:key="SecurityModelPrivilegeRowTemplate" [ DataType = PrivilegeRowViewModel ] {
        Grid [ Style = @TenantTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            RowDefinitions {
                RowDefinition [ Height = GridLength.Auto ]
                RowDefinition [ Height = GridLength.Auto ]
            }
            TextBlock [ Grid.Column = 0, Text = $Concept, Style = @UiLabel, Foreground = @Fg0, VerticalAlignment = Center ]
            Border [ Grid.Column = 1, DataContext = $Create ] {
                StackPanel [ Orientation = Horizontal ] {
                    Button [ Variant = Ghost, Command = $CycleCommand, HorizontalAlignment = Left, ToolTipService.ToolTip = $DefaultText ] { TextBlock [ Text = $Glyph ] }
                    TextBlock [ Text = "•", Foreground = @Fg2, VerticalAlignment = Center, Visibility = $IsOverridden << ToVisibility ]
                    Button [ Variant = Ghost, Command = $ResetCommand, Visibility = $IsOverridden << ToVisibility ] { TextBlock [ Text = "↺" ] }
                }
            }
            Border [ Grid.Column = 2, DataContext = $Read ] {
                StackPanel [ Orientation = Horizontal ] {
                    Button [ Variant = Ghost, Command = $CycleCommand, HorizontalAlignment = Left, ToolTipService.ToolTip = $DefaultText ] { TextBlock [ Text = $Glyph ] }
                    TextBlock [ Text = "•", Foreground = @Fg2, VerticalAlignment = Center, Visibility = $IsOverridden << ToVisibility ]
                    Button [ Variant = Ghost, Command = $ResetCommand, Visibility = $IsOverridden << ToVisibility ] { TextBlock [ Text = "↺" ] }
                }
            }
            Border [ Grid.Column = 3, DataContext = $Update ] {
                StackPanel [ Orientation = Horizontal ] {
                    Button [ Variant = Ghost, Command = $CycleCommand, HorizontalAlignment = Left, ToolTipService.ToolTip = $DefaultText ] { TextBlock [ Text = $Glyph ] }
                    TextBlock [ Text = "•", Foreground = @Fg2, VerticalAlignment = Center, Visibility = $IsOverridden << ToVisibility ]
                    Button [ Variant = Ghost, Command = $ResetCommand, Visibility = $IsOverridden << ToVisibility ] { TextBlock [ Text = "↺" ] }
                }
            }
            Border [ Grid.Column = 4, DataContext = $Delete ] {
                StackPanel [ Orientation = Horizontal ] {
                    Button [ Variant = Ghost, Command = $CycleCommand, HorizontalAlignment = Left, ToolTipService.ToolTip = $DefaultText ] { TextBlock [ Text = $Glyph ] }
                    TextBlock [ Text = "•", Foreground = @Fg2, VerticalAlignment = Center, Visibility = $IsOverridden << ToVisibility ]
                    Button [ Variant = Ghost, Command = $ResetCommand, Visibility = $IsOverridden << ToVisibility ] { TextBlock [ Text = "↺" ] }
                }
            }
            Border [ Grid.Column = 5, DataContext = $Append ] {
                StackPanel [ Orientation = Horizontal ] {
                    Button [ Variant = Ghost, Command = $CycleCommand, HorizontalAlignment = Left, ToolTipService.ToolTip = $DefaultText ] { TextBlock [ Text = $Glyph ] }
                    TextBlock [ Text = "•", Foreground = @Fg2, VerticalAlignment = Center, Visibility = $IsOverridden << ToVisibility ]
                    Button [ Variant = Ghost, Command = $ResetCommand, Visibility = $IsOverridden << ToVisibility ] { TextBlock [ Text = "↺" ] }
                }
            }
            Border [ Grid.Column = 6, DataContext = $AppendTo ] {
                StackPanel [ Orientation = Horizontal ] {
                    Button [ Variant = Ghost, Command = $CycleCommand, HorizontalAlignment = Left, ToolTipService.ToolTip = $DefaultText ] { TextBlock [ Text = $Glyph ] }
                    TextBlock [ Text = "•", Foreground = @Fg2, VerticalAlignment = Center, Visibility = $IsOverridden << ToVisibility ]
                    Button [ Variant = Ghost, Command = $ResetCommand, Visibility = $IsOverridden << ToVisibility ] { TextBlock [ Text = "↺" ] }
                }
            }
            Border [ Grid.Column = 7, DataContext = $Assign ] {
                StackPanel [ Orientation = Horizontal ] {
                    Button [ Variant = Ghost, Command = $CycleCommand, HorizontalAlignment = Left, ToolTipService.ToolTip = $DefaultText ] { TextBlock [ Text = $Glyph ] }
                    TextBlock [ Text = "•", Foreground = @Fg2, VerticalAlignment = Center, Visibility = $IsOverridden << ToVisibility ]
                    Button [ Variant = Ghost, Command = $ResetCommand, Visibility = $IsOverridden << ToVisibility ] { TextBlock [ Text = "↺" ] }
                }
            }
            Border [ Grid.Column = 8, DataContext = $Share ] {
                StackPanel [ Orientation = Horizontal ] {
                    Button [ Variant = Ghost, Command = $CycleCommand, HorizontalAlignment = Left, ToolTipService.ToolTip = $DefaultText ] { TextBlock [ Text = $Glyph ] }
                    TextBlock [ Text = "•", Foreground = @Fg2, VerticalAlignment = Center, Visibility = $IsOverridden << ToVisibility ]
                    Button [ Variant = Ghost, Command = $ResetCommand, Visibility = $IsOverridden << ToVisibility ] { TextBlock [ Text = "↺" ] }
                }
            }
            Border [ Grid.Column = 9, DataContext = $Invoke ] {
                StackPanel [ Orientation = Horizontal ] {
                    Button [ Variant = Ghost, Command = $CycleCommand, HorizontalAlignment = Left, ToolTipService.ToolTip = $DefaultText ] { TextBlock [ Text = $Glyph ] }
                    TextBlock [ Text = "•", Foreground = @Fg2, VerticalAlignment = Center, Visibility = $IsOverridden << ToVisibility ]
                    Button [ Variant = Ghost, Command = $ResetCommand, Visibility = $IsOverridden << ToVisibility ] { TextBlock [ Text = "↺" ] }
                }
            }
            TextBlock [ Grid.Row = 1, Grid.Column = 0, Grid.ColumnSpan = 10, Text = $Sentence, Style = @BodySm, Foreground = @Fg2,
                        TextWrapping = Wrap, Margin = (0,2,0,4) ]
        }
    }

    DataTemplate x:key="SecurityModelLegendTemplate" [ DataType = LegendEntryViewModel ] {
        TextBlock [ Text = $Line, Foreground = @Fg1, Margin = (8,2,8,2) ]
    }

    DataTemplate x:key="SecurityModelFieldGrantTemplate" [ DataType = FieldGrantRowViewModel ] {
        Grid [ Style = @TenantTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            TextBlock [ Grid.Column = 0, Text = $Label, Style = @Code, Foreground = @Fg0, VerticalAlignment = Center ]
            Checkbox [ HorizontalAlignment = Left, Grid.Column = 1, IsChecked = $CanRead, IsEnabled = $IsEditable, VerticalAlignment = Center ]
            Checkbox [ HorizontalAlignment = Left, Grid.Column = 2, IsChecked = $CanUpdate, IsEnabled = $IsEditable, VerticalAlignment = Center ]
            Checkbox [ HorizontalAlignment = Left, Grid.Column = 3, IsChecked = $CanCreate, IsEnabled = $IsEditable, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 4, Text = $DefaultText, Foreground = @Fg2, VerticalAlignment = Center ]
            StackPanel [ Grid.Column = 5, Orientation = Horizontal ] {
                TextBlock [ Text = "•", Foreground = @Fg2, VerticalAlignment = Center, Visibility = $IsOverridden << ToVisibility ]
                Button [ Variant = Ghost, Command = $ResetCommand, Visibility = $IsOverridden << ToVisibility ] { TextBlock [ Text = "↺" ] }
            }
        }
    }

    // ---- Who holds a role / profile ----

    DataTemplate [ DataType = AssignmentEditorViewModel ] {
        StackPanel [ Orientation = Vertical ] {
            TextBlock [ Text = $NoAssignmentsText, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,0,0,8),
                        Visibility = $HasNoAssignments << ToVisibility ]

            TextBlock [ Text = "By person", Style = @TenantSectionCaption ]
            ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $PrincipalRows,
                      ItemTemplate = @SecurityModelPrincipalGrantTemplate ]
            Grid [ Margin = (0,4,0,12) ] {
                ColumnDefinitions {
                    ColumnDefinition [ Width = GridLength.Star ]
                    ColumnDefinition [ Width = GridLength.Auto ]
                }
                TextBox [ UsesNativeInput = true, Grid.Column = 0, Text = $NewPrincipal, Placeholder = "Person (principal id)", IsEnabled = $CanEdit, Margin = (0,0,8,0) ]
                Button [ Grid.Column = 1, Variant = Secondary, Command = $AddPersonCommand ] {
                    TextBlock [ Text = "Add person" ]
                }
            }

            TextBlock [ Text = "By team", Style = @TenantSectionCaption ]
            ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $TeamRows,
                      ItemTemplate = @SecurityModelTeamGrantTemplate ]
            Grid [ Margin = (0,4,0,0) ] {
                ColumnDefinitions {
                    ColumnDefinition [ Width = GridLength.Star ]
                    ColumnDefinition [ Width = GridLength.Auto ]
                }
                ComboBox [ Grid.Column = 0, ItemsSource = $TeamOptions, SelectedItem = $SelectedTeamOption, Placeholder = "(pick a team)",
                           IsEnabled = $CanEdit, HorizontalAlignment = Stretch, Margin = (0,0,8,0) ]
                Button [ Grid.Column = 1, Variant = Secondary, Command = $AddTeamCommand ] {
                    TextBlock [ Text = "Add team" ]
                }
            }
        }
    }

    DataTemplate x:key="SecurityModelPrincipalGrantTemplate" [ DataType = AssignmentPrincipalRowViewModel ] {
        Grid [ Style = @TenantTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Auto ]
            }
            TextBlock [ Grid.Column = 0, Text = $PrincipalId, Style = @Code, Foreground = @Fg0, VerticalAlignment = Center ]
            Button [ Grid.Column = 1, Variant = Ghost, Command = $RemoveCommand ] {
                TextBlock [ Text = "Remove" ]
            }
        }
    }

    DataTemplate x:key="SecurityModelTeamGrantTemplate" [ DataType = AssignmentTeamRowViewModel ] {
        Grid [ Style = @TenantTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Auto ]
            }
            TextBlock [ Grid.Column = 0, Text = $TeamName, Foreground = @Fg0, VerticalAlignment = Center ]
            Button [ Grid.Column = 1, Variant = Ghost, Command = $RemoveCommand ] {
                TextBlock [ Text = "Remove" ]
            }
        }
    }

    // ---- Organization rows ----

    DataTemplate x:key="SecurityModelBusinessUnitTemplate" [ DataType = BusinessUnitRowViewModel ] {
        Grid [ Style = @TenantTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Auto ]
            }
            DockPanel [ Grid.Column = 0, Margin = (0,0,8,0) ] {
                TextBlock [ DockPanel.Dock = Left, Text = $Indent, VerticalAlignment = Center ]
                TextBox [ UsesNativeInput = true, Text = $Name, Placeholder = "Business unit name", IsEnabled = $CanEdit ]
            }
            ComboBox [ Grid.Column = 1, ItemsSource = $ParentOptions, SelectedItem = $SelectedParent, IsEnabled = $CanEdit,
                       HorizontalAlignment = Stretch, Margin = (0,0,8,0) ]
            StackPanel [ Grid.Column = 2, Orientation = Vertical ] {
                Button [ Variant = Ghost, Command = $RemoveCommand ] {
                    TextBlock [ Text = "Remove" ]
                }
                TextBlock [ Text = $CannotRemoveText, Foreground = @Fg2, Visibility = $IsRemoveBlocked << ToVisibility ]
            }
        }
    }

    DataTemplate x:key="SecurityModelUserPlacementTemplate" [ DataType = UserPlacementRowViewModel ] {
        Grid [ Style = @TenantTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Auto ]
            }
            TextBlock [ Grid.Column = 0, Text = $PrincipalId, Foreground = @Fg0, VerticalAlignment = Center, Margin = (0,0,8,0) ]
            ComboBox [ Grid.Column = 1, ItemsSource = $UnitOptions, SelectedItem = $SelectedUnit, IsEnabled = $CanEdit,
                       HorizontalAlignment = Stretch, Margin = (0,0,8,0) ]
            Button [ Grid.Column = 2, Variant = Ghost, Command = $RemoveCommand ] {
                TextBlock [ Text = "Remove" ]
            }
        }
    }

    DataTemplate x:key="SecurityModelIdpGroupTemplate" [ DataType = IdpGroupRowViewModel ] {
        Grid [ Margin = (0,2,0,2) ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Auto ]
            }
            TextBlock [ Grid.Column = 0, Text = $Group, Foreground = @Fg0, VerticalAlignment = Center ]
            Button [ Grid.Column = 1, Variant = Ghost, Command = $RemoveCommand ] {
                TextBlock [ Text = "Remove" ]
            }
        }
    }

    DataTemplate x:key="SecurityModelTeamMemberTemplate" [ DataType = TeamMemberRowViewModel ] {
        Grid [ Margin = (0,2,0,2) ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Auto ]
            }
            TextBlock [ Grid.Column = 0, Text = $PrincipalId, Foreground = @Fg0, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 1, Text = $OriginText, Foreground = @Fg2, VerticalAlignment = Center ]
            Button [ Grid.Column = 2, Variant = Ghost, Command = $RemoveCommand ] {
                TextBlock [ Text = "Remove" ]
            }
        }
    }

    DataTemplate x:key="SecurityModelTeamTemplate" [ DataType = TeamRowViewModel ] {
        StackPanel [ Orientation = Vertical ] {
            Grid [ Style = @TenantTableColumns ] {
                ColumnDefinitions {
                    ColumnDefinition [ Width = GridLength.Star ]
                    ColumnDefinition [ Width = GridLength.Star ]
                    ColumnDefinition [ Width = GridLength.Auto ]
                }
                TextBox [ UsesNativeInput = true, Grid.Column = 0, Text = $Name, Placeholder = "Team name", IsEnabled = $CanEdit, Margin = (0,0,8,0) ]
                ComboBox [ Grid.Column = 1, ItemsSource = $UnitOptions, SelectedItem = $SelectedUnit, IsEnabled = $CanEdit,
                           HorizontalAlignment = Stretch, Margin = (0,0,8,0) ]
                Button [ Grid.Column = 2, Variant = Ghost, Command = $RemoveCommand ] {
                    TextBlock [ Text = "Remove" ]
                }
            }

            TextBlock [ Text = "Identity provider groups", Style = @TenantSectionCaption ]
            ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $IdpGroups,
                      ItemTemplate = @SecurityModelIdpGroupTemplate ]
            Grid [ Margin = (0,4,0,8) ] {
                ColumnDefinitions {
                    ColumnDefinition [ Width = GridLength.Star ]
                    ColumnDefinition [ Width = GridLength.Auto ]
                }
                TextBox [ UsesNativeInput = true, Grid.Column = 0, Text = $NewIdpGroup, Placeholder = "Group name or id", IsEnabled = $CanEdit, Margin = (0,0,8,0) ]
                Button [ Grid.Column = 1, Variant = Secondary, Command = $AddIdpGroupCommand ] {
                    TextBlock [ Text = "Link group" ]
                }
            }

            Grid [ Margin = (0,4,0,0) ] {
                ColumnDefinitions {
                    ColumnDefinition [ Width = GridLength.Star ]
                    ColumnDefinition [ Width = GridLength.Auto ]
                }
                TextBlock [ Grid.Column = 0, Text = "Members", Style = @TenantSectionCaption ]
                Button [ Grid.Column = 1, Variant = Ghost, Command = $LoadMembersCommand ] {
                    TextBlock [ Text = "Show members" ]
                }
            }
            TextBlock [ Text = "Members from the identity provider are not shown until you press Show members.", Foreground = @Fg2,
                        Visibility = $ShowMembersHint << ToVisibility ]
            TextBlock [ Text = $MembersErrorText, Foreground = @Fg2, Visibility = $HasMembersError << ToVisibility ]
            ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $Members,
                      ItemTemplate = @SecurityModelTeamMemberTemplate ]
            Grid [ Margin = (0,4,0,8) ] {
                ColumnDefinitions {
                    ColumnDefinition [ Width = GridLength.Star ]
                    ColumnDefinition [ Width = GridLength.Auto ]
                }
                TextBox [ UsesNativeInput = true, Grid.Column = 0, Text = $NewManualMember, Placeholder = "Person id", IsEnabled = $CanEdit, Margin = (0,0,8,0) ]
                Button [ Grid.Column = 1, Variant = Secondary, Command = $AddManualMemberCommand ] {
                    TextBlock [ Text = "Add member" ]
                }
            }
        }
    }
}
