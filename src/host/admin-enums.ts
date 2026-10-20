import { Role, ResourceKind, DelegationDepth } from '@pragmatic-tech-ai/todl-identity'

/** Raised when a wire string does not name a known enum member. The message names the FIELD, never the offending value. */
export class AdminEnumError extends Error
{
    public readonly Field: string

    public constructor(field: string)
    {
        super(`unknown value for field: ${field}`)
        this.name = 'AdminEnumError'
        this.Field = field
    }
}

/** Fail-closed string to enum mappers for the admin wire DTOs. Names are the enum identifiers. */
export class AdminEnums
{
    private static readonly RoleField = 'role'
    private static readonly ResourceKindField = 'resourceKind'
    private static readonly DelegationDepthField = 'delegationDepth'

    private static readonly Roles: ReadonlyMap<string, Role> = new Map<string, Role>([
        ['Owner', Role.Owner],
        ['Admin', Role.Admin],
        ['Editor', Role.Editor],
        ['Viewer', Role.Viewer],
        ['Maker', Role.Maker],
    ])

    private static readonly ResourceKinds: ReadonlyMap<string, ResourceKind> = new Map<string, ResourceKind>([
        ['Tenant', ResourceKind.Tenant],
        ['Project', ResourceKind.Project],
        ['Model', ResourceKind.Model],
        ['Connector', ResourceKind.Connector],
    ])

    private static readonly Depths: ReadonlyMap<string, DelegationDepth> = new Map<string, DelegationDepth>([
        ['AuthnDirectory', DelegationDepth.AuthnDirectory],
        ['ExternalGrants', DelegationDepth.ExternalGrants],
        ['FullAuthz', DelegationDepth.FullAuthz],
    ])

    public static RoleFromName(name: string): Role
    {
        return AdminEnums.Lookup(AdminEnums.Roles, name, AdminEnums.RoleField)
    }

    public static NameOfRole(role: Role): string
    {
        return AdminEnums.NameOf(AdminEnums.Roles, role, AdminEnums.RoleField)
    }

    public static ResourceKindFromName(name: string): ResourceKind
    {
        return AdminEnums.Lookup(AdminEnums.ResourceKinds, name, AdminEnums.ResourceKindField)
    }

    public static NameOfResourceKind(kind: ResourceKind): string
    {
        return AdminEnums.NameOf(AdminEnums.ResourceKinds, kind, AdminEnums.ResourceKindField)
    }

    public static DepthFromName(name: string): DelegationDepth
    {
        return AdminEnums.Lookup(AdminEnums.Depths, name, AdminEnums.DelegationDepthField)
    }

    public static NameOfDepth(depth: DelegationDepth): string
    {
        return AdminEnums.NameOf(AdminEnums.Depths, depth, AdminEnums.DelegationDepthField)
    }

    private static Lookup<T>(table: ReadonlyMap<string, T>, name: string, field: string): T
    {
        const value = typeof name === 'string' ? table.get(name) : undefined
        if (value === undefined)
        {
            throw new AdminEnumError(field)
        }
        return value
    }

    private static NameOf<T>(table: ReadonlyMap<string, T>, value: T, field: string): string
    {
        for (const [name, candidate] of table)
        {
            if (candidate === value)
            {
                return name
            }
        }
        throw new AdminEnumError(field)
    }
}
