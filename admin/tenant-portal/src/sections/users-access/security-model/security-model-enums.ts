export enum PrivilegeAction
{
    Create = 'create',
    Read = 'read',
    Update = 'update',
    Delete = 'delete',
    Append = 'append',
    AppendTo = 'appendTo',
    Assign = 'assign',
    Share = 'share'
}

export enum AccessLevel
{
    None = 'none',
    User = 'user',
    BusinessUnit = 'businessUnit',
    BusinessUnitAndChildren = 'businessUnitAndChildren',
    Organization = 'organization'
}

export enum FieldPermission
{
    Read = 'read',
    Update = 'update',
    Create = 'create'
}

export const FieldPermissions: readonly FieldPermission[] = [
    FieldPermission.Read,
    FieldPermission.Update,
    FieldPermission.Create
]

export const Actions: readonly PrivilegeAction[] = [
    PrivilegeAction.Create,
    PrivilegeAction.Read,
    PrivilegeAction.Update,
    PrivilegeAction.Delete,
    PrivilegeAction.Append,
    PrivilegeAction.AppendTo,
    PrivilegeAction.Assign,
    PrivilegeAction.Share
]

export const LevelCycle: readonly AccessLevel[] = [
    AccessLevel.None,
    AccessLevel.User,
    AccessLevel.BusinessUnit,
    AccessLevel.BusinessUnitAndChildren,
    AccessLevel.Organization
]
