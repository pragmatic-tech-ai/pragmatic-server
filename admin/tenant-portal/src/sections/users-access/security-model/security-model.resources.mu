// security-model.resources.mu - the Roles & permissions tab: the security-model
// editor for the environment the Users & Access page selected. Merged by
// UsersAccessModule.
//
// One draft, one save bar (bottom) for the whole model. Mode tabs Roles |
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
import AssignmentClaimRowViewModel from "./assignment-editor-view-model.js"
import AssignmentTeamRowViewModel from "./assignment-editor-view-model.js"
import RoleItemViewModel from "./security-model-role-rows.js"
import ProfileItemViewModel from "./security-model-role-rows.js"
import PrivilegeRowViewModel from "./security-model-role-rows.js"
import LegendEntryViewModel from "./security-model-role-rows.js"
import FieldGrantRowViewModel from "./security-model-role-rows.js"
import RecordSharingRowViewModel from "./security-model-role-rows.js"
import BusinessUnitRowViewModel from "./security-model-org-rows.js"
import TeamRowViewModel from "./security-model-org-rows.js"
import TeamToggleViewModel from "./security-model-org-rows.js"
import MembershipRuleRowViewModel from "./security-model-org-rows.js"
import MembershipOverrideRowViewModel from "./security-model-org-rows.js"
import OwnershipRuleRowViewModel from "./security-model-org-rows.js"

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
                        SegmentedButton [ Items = $ModeLabels, SelectedItem = $SelectedMode, SelectionMode = Single, HorizontalAlignment = Left ]
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
                            TextBlock [ Text = "No roles yet. Add a role to start.", Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,0,0,8),
                                        Visibility = $HasNoRoles << ToVisibility ]
                            ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $Roles,
                                      SelectedItem = $SelectedRole, ItemTemplate = @SecurityModelRoleItemTemplate,
                                      Visibility = $HasRoles << ToVisibility ]
                            TextBox [ Text = $NewRoleName, Placeholder = "New role name", IsEnabled = $CanEdit, Margin = (0,8,0,4) ]
                            StackPanel [ Orientation = Horizontal ] {
                                Button [ Variant = Secondary, Command = $AddRoleCommand, Margin = (0,0,8,0) ] {
                                    TextBlock [ Text = "Add role" ]
                                }
                                Button [ Variant = Danger, Command = $DeleteRoleCommand, Visibility = $HasSelectedRole << ToVisibility ] {
                                    TextBlock [ Text = "Delete role" ]
                                }
                            }
                        }

                        // The selected role's tabs.
                        StackPanel [ Grid.Column = 1, Grid.ColumnSpan = 3, Orientation = Vertical ] {
                            TextBlock [ Text = $SelectedRoleName, Style = @H4, Foreground = @Fg0, Margin = (0,0,0,8),
                                        Visibility = $HasSelectedRole << ToVisibility ]
                            StackPanel [ Orientation = Horizontal, Margin = (0,0,0,12) ] {
                                SegmentedButton [ Items = $RoleTabLabels, SelectedItem = $SelectedRoleTab, SelectionMode = Single, HorizontalAlignment = Left ]
                            }

                            // What they can do: the privilege matrix.
                            StackPanel [ Orientation = Vertical, Visibility = $IsPrivilegesTab << ToVisibility ] {
                                TextBlock [ Text = "Select or add a role to edit what it can do.", Foreground = @Fg2,
                                            Visibility = $HasNoSelectedRole << ToVisibility ]
                                StackPanel [ Orientation = Vertical, Visibility = $HasSelectedRole << ToVisibility ] {
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
                                    }
                                    ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $PrivilegeRows,
                                              ItemTemplate = @SecurityModelPrivilegeRowTemplate ]
                                    Grid [ Margin = (0,8,0,0) ] {
                                        ColumnDefinitions {
                                            ColumnDefinition [ Width = GridLength.Star ]
                                            ColumnDefinition [ Width = GridLength.Auto ]
                                        }
                                        TextBox [ Grid.Column = 0, Text = $NewConceptName, Placeholder = "New concept name", IsEnabled = $CanEdit, Margin = (0,0,8,0) ]
                                        Button [ Grid.Column = 1, Variant = Secondary, Command = $AddConceptCommand ] {
                                            TextBlock [ Text = "Add concept" ]
                                        }
                                    }
                                    TextBlock [ Text = "Access levels", Style = @TenantSectionCaption, Margin = (0,16,0,4) ]
                                    ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $Legend,
                                              ItemTemplate = @SecurityModelLegendTemplate ]
                                }
                            }

                            // Fields: field profiles and their secured-field grants.
                            StackPanel [ Orientation = Vertical, Visibility = $IsFieldsTab << ToVisibility ] {
                                TextBlock [ Text = "Field profiles", Style = @TenantSectionCaption ]
                                ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $Profiles,
                                          SelectedItem = $SelectedProfile, ItemTemplate = @SecurityModelProfileItemTemplate ]
                                Grid [ Margin = (0,8,0,0) ] {
                                    ColumnDefinitions {
                                        ColumnDefinition [ Width = GridLength.Star ]
                                        ColumnDefinition [ Width = GridLength.Auto ]
                                        ColumnDefinition [ Width = GridLength.Auto ]
                                    }
                                    TextBox [ Grid.Column = 0, Text = $NewProfileName, Placeholder = "New profile name", IsEnabled = $CanEdit, Margin = (0,0,8,0) ]
                                    Button [ Grid.Column = 1, Variant = Secondary, Command = $AddProfileCommand, Margin = (0,0,8,0) ] {
                                        TextBlock [ Text = "Add profile" ]
                                    }
                                    Button [ Grid.Column = 2, Variant = Danger, Command = $DeleteProfileCommand,
                                             Visibility = $HasSelectedProfile << ToVisibility ] {
                                        TextBlock [ Text = "Delete profile" ]
                                    }
                                }
                                TextBlock [ Text = "Select or add a field profile to edit its field access.", Foreground = @Fg2, Margin = (0,12,0,0),
                                            Visibility = $HasNoSelectedProfile << ToVisibility ]
                                StackPanel [ Orientation = Vertical, Margin = (0,16,0,0), Visibility = $HasSelectedProfile << ToVisibility ] {
                                    TextBlock [ Text = "Secured fields", Style = @TenantSectionCaption ]
                                    TextBlock [ Text = "No secured fields yet.", Foreground = @Fg2, Visibility = $HasNoFieldRows << ToVisibility ]
                                    Grid [ Style = @TenantTableColumns ] {
                                        ColumnDefinitions {
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
                                    }
                                    ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $FieldRows,
                                              ItemTemplate = @SecurityModelFieldGrantTemplate ]
                                    Grid [ Margin = (0,8,0,0) ] {
                                        ColumnDefinitions {
                                            ColumnDefinition [ Width = GridLength.Star ]
                                            ColumnDefinition [ Width = GridLength.Star ]
                                            ColumnDefinition [ Width = GridLength.Auto ]
                                        }
                                        TextBox [ Grid.Column = 0, Text = $NewFieldConcept, Placeholder = "Concept", IsEnabled = $CanEdit, Margin = (0,0,8,0) ]
                                        TextBox [ Grid.Column = 1, Text = $NewFieldName, Placeholder = "Field", IsEnabled = $CanEdit, Margin = (0,0,8,0) ]
                                        Button [ Grid.Column = 2, Variant = Secondary, Command = $AddSecuredFieldCommand ] {
                                            TextBlock [ Text = "Add secured field" ]
                                        }
                                    }
                                    TextBlock [ Text = "Who has this profile", Style = @TenantSectionCaption, Margin = (0,16,0,6) ]
                                    ContentControl [ Content = $ProfileAssignment ]
                                }
                            }

                            // Record sharing: derived from the role's privileges, read-only.
                            StackPanel [ Orientation = Vertical, Visibility = $IsRecordSharingTab << ToVisibility ] {
                                TextBlock [ Text = "Select or add a role to see what records it reaches.", Foreground = @Fg2,
                                            Visibility = $HasNoSelectedRole << ToVisibility ]
                                StackPanel [ Orientation = Vertical, Visibility = $HasSelectedRole << ToVisibility ] {
                                    TextBlock [ Text = $NoRecordSharingText, Foreground = @Fg2, Visibility = $HasNoRecordSharing << ToVisibility ]
                                    ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $RecordSharingRows,
                                              ItemTemplate = @SecurityModelRecordSharingTemplate, Visibility = $HasRecordSharing << ToVisibility ]
                                }
                            }

                            // People: who holds the role.
                            StackPanel [ Orientation = Vertical, Visibility = $IsPeopleTab << ToVisibility ] {
                                TextBlock [ Text = "Select or add a role to see who holds it.", Foreground = @Fg2,
                                            Visibility = $HasNoSelectedRole << ToVisibility ]
                                StackPanel [ Orientation = Vertical, Visibility = $HasSelectedRole << ToVisibility ] {
                                    TextBlock [ Text = $RoleHoldersHeadline, Foreground = @Fg1, TextWrapping = Wrap, Margin = (0,0,0,12) ]
                                    ContentControl [ Content = $RoleAssignment ]
                                }
                            }
                        }
                    }

                    // ---- Organization mode ----
                    StackPanel [ Orientation = Vertical, Visibility = $IsOrganizationMode << ToVisibility ] {
                        StackPanel [ Orientation = Horizontal, Margin = (0,0,0,12) ] {
                            SegmentedButton [ Items = $OrgTabLabels, SelectedItem = $SelectedOrgTab, SelectionMode = Single, HorizontalAlignment = Left ]
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
                                TextBox [ Grid.Column = 0, Text = $NewBusinessUnitName, Placeholder = "New business unit name", IsEnabled = $CanEdit, Margin = (0,0,8,0) ]
                                Button [ Grid.Column = 1, Variant = Secondary, Command = $AddBusinessUnitCommand ] {
                                    TextBlock [ Text = "Add business unit" ]
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
                                TextBlock [ Grid.Column = 1, Text = "Owning business unit", Style = @TenantTableHeader ]
                            }
                            ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $TeamRows,
                                      ItemTemplate = @SecurityModelTeamTemplate ]
                            Grid [ Margin = (0,8,0,0) ] {
                                ColumnDefinitions {
                                    ColumnDefinition [ Width = GridLength.Star ]
                                    ColumnDefinition [ Width = GridLength.Auto ]
                                }
                                TextBox [ Grid.Column = 0, Text = $NewTeamName, Placeholder = "New team name", IsEnabled = $CanEdit, Margin = (0,0,8,0) ]
                                Button [ Grid.Column = 1, Variant = Secondary, Command = $AddTeamCommand ] {
                                    TextBlock [ Text = "Add team" ]
                                }
                            }
                        }

                        // Membership: claim rules and per-person overrides.
                        StackPanel [ Orientation = Vertical, Visibility = $IsMembershipTab << ToVisibility ] {
                            TextBlock [ Text = "Claim rules", Style = @TenantSectionCaption ]
                            Border [ Style = @TenantPanel ] {
                                StackPanel [ Orientation = Vertical ] {
                                    TextBlock [ Text = "No claim rules yet.", Foreground = @Fg2, Visibility = $HasNoMembershipRules << ToVisibility ]
                                    ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $MembershipRuleRows,
                                              ItemTemplate = @SecurityModelMembershipRuleTemplate ]
                                    Button [ Variant = Secondary, Command = $AddMembershipRuleCommand, HorizontalAlignment = Left, Margin = (0,8,0,0) ] {
                                        TextBlock [ Text = "Add claim rule" ]
                                    }
                                }
                            }
                            TextBlock [ Text = "Per-person overrides", Style = @TenantSectionCaption ]
                            Border [ Style = @TenantPanel ] {
                                StackPanel [ Orientation = Vertical ] {
                                    TextBlock [ Text = "No per-person overrides yet.", Foreground = @Fg2, Visibility = $HasNoMembershipOverrides << ToVisibility ]
                                    ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $MembershipOverrideRows,
                                              ItemTemplate = @SecurityModelMembershipOverrideTemplate ]
                                    Button [ Variant = Secondary, Command = $AddMembershipOverrideCommand, HorizontalAlignment = Left, Margin = (0,8,0,0) ] {
                                        TextBlock [ Text = "Add override" ]
                                    }
                                }
                            }
                        }

                        // Ownership rules.
                        StackPanel [ Orientation = Vertical, Visibility = $IsOwnershipTab << ToVisibility ] {
                            TextBlock [ Text = "No ownership rules yet. Add one per concept.", Foreground = @Fg2,
                                        Visibility = $HasNoOwnershipRules << ToVisibility ]
                            Grid [ Style = @TenantTableColumns ] {
                                ColumnDefinitions {
                                    ColumnDefinition [ Width = GridLength.Star ]
                                    ColumnDefinition [ Width = GridLength.Star ]
                                    ColumnDefinition [ Width = GridLength.Star ]
                                    ColumnDefinition [ Width = GridLength.Star ]
                                    ColumnDefinition [ Width = GridLength.Star ]
                                    ColumnDefinition [ Width = GridLength.Auto ]
                                }
                                TextBlock [ Grid.Column = 0, Text = "Concept", Style = @TenantTableHeader ]
                                TextBlock [ Grid.Column = 1, Text = "Owning unit from", Style = @TenantTableHeader ]
                                TextBlock [ Grid.Column = 2, Text = "Owning unit value", Style = @TenantTableHeader ]
                                TextBlock [ Grid.Column = 3, Text = "Owner from", Style = @TenantTableHeader ]
                                TextBlock [ Grid.Column = 4, Text = "Owner value", Style = @TenantTableHeader ]
                            }
                            ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $OwnershipRuleRows,
                                      ItemTemplate = @SecurityModelOwnershipRuleTemplate ]
                            Grid [ Margin = (0,8,0,0) ] {
                                ColumnDefinitions {
                                    ColumnDefinition [ Width = GridLength.Star ]
                                    ColumnDefinition [ Width = GridLength.Auto ]
                                }
                                TextBox [ Grid.Column = 0, Text = $NewOwnershipConcept, Placeholder = "Concept to own", IsEnabled = $CanEdit, Margin = (0,0,8,0) ]
                                Button [ Grid.Column = 1, Variant = Secondary, Command = $AddOwnershipRuleCommand ] {
                                    TextBlock [ Text = "Add ownership rule" ]
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

    // A concept row: the concept, a level button per action (same nine
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
            }
            RowDefinitions {
                RowDefinition [ Height = GridLength.Auto ]
                RowDefinition [ Height = GridLength.Auto ]
            }
            TextBlock [ Grid.Column = 0, Text = $Concept, Style = @UiLabel, Foreground = @Fg0, VerticalAlignment = Center ]
            Border [ Grid.Column = 1, DataContext = $Create ] {
                Button [ Variant = Ghost, Command = $CycleCommand, HorizontalAlignment = Left ] { TextBlock [ Text = $Glyph ] }
            }
            Border [ Grid.Column = 2, DataContext = $Read ] {
                Button [ Variant = Ghost, Command = $CycleCommand, HorizontalAlignment = Left ] { TextBlock [ Text = $Glyph ] }
            }
            Border [ Grid.Column = 3, DataContext = $Update ] {
                Button [ Variant = Ghost, Command = $CycleCommand, HorizontalAlignment = Left ] { TextBlock [ Text = $Glyph ] }
            }
            Border [ Grid.Column = 4, DataContext = $Delete ] {
                Button [ Variant = Ghost, Command = $CycleCommand, HorizontalAlignment = Left ] { TextBlock [ Text = $Glyph ] }
            }
            Border [ Grid.Column = 5, DataContext = $Append ] {
                Button [ Variant = Ghost, Command = $CycleCommand, HorizontalAlignment = Left ] { TextBlock [ Text = $Glyph ] }
            }
            Border [ Grid.Column = 6, DataContext = $AppendTo ] {
                Button [ Variant = Ghost, Command = $CycleCommand, HorizontalAlignment = Left ] { TextBlock [ Text = $Glyph ] }
            }
            Border [ Grid.Column = 7, DataContext = $Assign ] {
                Button [ Variant = Ghost, Command = $CycleCommand, HorizontalAlignment = Left ] { TextBlock [ Text = $Glyph ] }
            }
            Border [ Grid.Column = 8, DataContext = $Share ] {
                Button [ Variant = Ghost, Command = $CycleCommand, HorizontalAlignment = Left ] { TextBlock [ Text = $Glyph ] }
            }
            TextBlock [ Grid.Row = 1, Grid.Column = 0, Grid.ColumnSpan = 9, Text = $Sentence, Style = @BodySm, Foreground = @Fg2,
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
            }
            TextBlock [ Grid.Column = 0, Text = $Label, Style = @Code, Foreground = @Fg0, VerticalAlignment = Center ]
            Checkbox [ Grid.Column = 1, IsChecked = $CanRead, IsEnabled = $CanEdit, VerticalAlignment = Center ]
            Checkbox [ Grid.Column = 2, IsChecked = $CanUpdate, IsEnabled = $CanEdit, VerticalAlignment = Center ]
            Checkbox [ Grid.Column = 3, IsChecked = $CanCreate, IsEnabled = $CanEdit, VerticalAlignment = Center ]
            Button [ Grid.Column = 4, Variant = Ghost, Command = $RemoveCommand, HorizontalAlignment = Left ] {
                TextBlock [ Text = "Remove" ]
            }
        }
    }

    DataTemplate x:key="SecurityModelRecordSharingTemplate" [ DataType = RecordSharingRowViewModel ] {
        Grid [ Style = @TenantTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Auto ]
                ColumnDefinition [ Width = GridLength.Auto ]
            }
            TextBlock [ Grid.Column = 0, Text = $Concept, Style = @UiLabel, Foreground = @Fg0 ]
            TextBlock [ Grid.Column = 1, Text = $ScopeText, Foreground = @Fg1, TextWrapping = Wrap ]
            Border [ Grid.Column = 2, Fill = @StateSuccessSoft, Padding = (8,2,8,2), Margin = (8,0,0,0),
                     Visibility = $CanShare << ToVisibility ] {
                TextBlock [ Text = "Can share", Style = @UiCaption, Foreground = @StateSuccessInk ]
            }
            Border [ Grid.Column = 3, Fill = @StateSuccessSoft, Padding = (8,2,8,2), Margin = (8,0,0,0),
                     Visibility = $CanAssign << ToVisibility ] {
                TextBlock [ Text = "Can assign", Style = @UiCaption, Foreground = @StateSuccessInk ]
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
                TextBox [ Grid.Column = 0, Text = $NewPrincipal, Placeholder = "Person (principal id)", IsEnabled = $CanEdit, Margin = (0,0,8,0) ]
                Button [ Grid.Column = 1, Variant = Secondary, Command = $AddPersonCommand ] {
                    TextBlock [ Text = "Add person" ]
                }
            }

            TextBlock [ Text = "By claim", Style = @TenantSectionCaption ]
            ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $ClaimRows,
                      ItemTemplate = @SecurityModelClaimGrantTemplate ]
            Button [ Variant = Secondary, Command = $AddClaimCommand, HorizontalAlignment = Left, Margin = (0,4,0,12) ] {
                TextBlock [ Text = "Add claim" ]
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

    DataTemplate x:key="SecurityModelClaimGrantTemplate" [ DataType = AssignmentClaimRowViewModel ] {
        Grid [ Style = @TenantTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Auto ]
            }
            TextBox [ Grid.Column = 0, Text = $Claim, Placeholder = "Claim", IsEnabled = $CanEdit, Margin = (0,0,8,0) ]
            TextBox [ Grid.Column = 1, Text = $Value, Placeholder = "Value", IsEnabled = $CanEdit, Margin = (0,0,8,0) ]
            Button [ Grid.Column = 2, Variant = Ghost, Command = $RemoveCommand ] {
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
                TextBox [ Text = $Name, Placeholder = "Business unit name", IsEnabled = $CanEdit ]
            }
            ComboBox [ Grid.Column = 1, ItemsSource = $ParentOptions, SelectedItem = $SelectedParent, IsEnabled = $CanEdit,
                       HorizontalAlignment = Stretch, Margin = (0,0,8,0) ]
            Button [ Grid.Column = 2, Variant = Ghost, Command = $RemoveCommand ] {
                TextBlock [ Text = "Remove" ]
            }
        }
    }

    DataTemplate x:key="SecurityModelTeamTemplate" [ DataType = TeamRowViewModel ] {
        Grid [ Style = @TenantTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Auto ]
            }
            TextBox [ Grid.Column = 0, Text = $Name, Placeholder = "Team name", IsEnabled = $CanEdit, Margin = (0,0,8,0) ]
            ComboBox [ Grid.Column = 1, ItemsSource = $UnitOptions, SelectedItem = $SelectedUnit, IsEnabled = $CanEdit,
                       HorizontalAlignment = Stretch, Margin = (0,0,8,0) ]
            Button [ Grid.Column = 2, Variant = Ghost, Command = $RemoveCommand ] {
                TextBlock [ Text = "Remove" ]
            }
        }
    }

    DataTemplate x:key="SecurityModelTeamToggleTemplate" [ DataType = TeamToggleViewModel ] {
        StackPanel [ Orientation = Horizontal, Margin = (0,2,0,2) ] {
            Checkbox [ IsChecked = $IsChecked, IsEnabled = $CanEdit, VerticalAlignment = Center, Margin = (0,0,6,0) ]
            TextBlock [ Text = $TeamName, Foreground = @Fg1, VerticalAlignment = Center ]
        }
    }

    DataTemplate x:key="SecurityModelMembershipRuleTemplate" [ DataType = MembershipRuleRowViewModel ] {
        Grid [ Style = @TenantTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Auto ]
            }
            TextBox [ Grid.Column = 0, Text = $Claim, Placeholder = "Claim", IsEnabled = $CanEdit, Margin = (0,0,8,0) ]
            TextBox [ Grid.Column = 1, Text = $Value, Placeholder = "Value", IsEnabled = $CanEdit, Margin = (0,0,8,0) ]
            ComboBox [ Grid.Column = 2, ItemsSource = $UnitOptions, SelectedItem = $SelectedHomeUnit, IsEnabled = $CanEdit,
                       HorizontalAlignment = Stretch, Margin = (0,0,8,0) ]
            ListBox [ Grid.Column = 3, Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $TeamToggles,
                      ItemTemplate = @SecurityModelTeamToggleTemplate, Visibility = $HasTeams << ToVisibility ]
            Button [ Grid.Column = 4, Variant = Ghost, Command = $RemoveCommand ] {
                TextBlock [ Text = "Remove" ]
            }
        }
    }

    DataTemplate x:key="SecurityModelMembershipOverrideTemplate" [ DataType = MembershipOverrideRowViewModel ] {
        Grid [ Style = @TenantTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Auto ]
            }
            TextBox [ Grid.Column = 0, Text = $PrincipalId, Placeholder = "Principal id", IsEnabled = $CanEdit, Margin = (0,0,8,0) ]
            ComboBox [ Grid.Column = 1, ItemsSource = $UnitOptions, SelectedItem = $SelectedHomeUnit, IsEnabled = $CanEdit,
                       HorizontalAlignment = Stretch, Margin = (0,0,8,0) ]
            ListBox [ Grid.Column = 2, Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $TeamToggles,
                      ItemTemplate = @SecurityModelTeamToggleTemplate, Visibility = $HasTeams << ToVisibility ]
            Button [ Grid.Column = 3, Variant = Ghost, Command = $RemoveCommand ] {
                TextBlock [ Text = "Remove" ]
            }
        }
    }

    DataTemplate x:key="SecurityModelOwnershipRuleTemplate" [ DataType = OwnershipRuleRowViewModel ] {
        Grid [ Style = @TenantTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Auto ]
            }
            TextBlock [ Grid.Column = 0, Text = $Concept, Style = @UiLabel, Foreground = @Fg0, VerticalAlignment = Center ]
            TextBox [ Grid.Column = 1, Text = $OwningKind, Placeholder = "Source kind", IsEnabled = $CanEdit, Margin = (0,0,8,0) ]
            TextBox [ Grid.Column = 2, Text = $OwningValue, Placeholder = "Source value", IsEnabled = $CanEdit, Margin = (0,0,8,0) ]
            TextBox [ Grid.Column = 3, Text = $OwnerKind, Placeholder = "Source kind", IsEnabled = $CanEdit, Margin = (0,0,8,0) ]
            TextBox [ Grid.Column = 4, Text = $OwnerValue, Placeholder = "Source value", IsEnabled = $CanEdit, Margin = (0,0,8,0) ]
            Button [ Grid.Column = 5, Variant = Ghost, Command = $RemoveCommand ] {
                TextBlock [ Text = "Remove" ]
            }
        }
    }
}
