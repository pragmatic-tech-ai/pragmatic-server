import type { PrivilegeDto, RoleConfigDto, SecurityModelDto } from './tenant-types.js'

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

// Pure state for the roles/privilege matrix. Owns a deep clone of the loaded
// model; ToDto() emits another deep clone, so the input is never mutated and
// every section the matrix does not edit round-trips untouched.
export class SecurityModelDraft
{
    private static readonly RoleIdPrefix = 'role-'
    private static readonly SlugSeparator = '-'
    private static readonly NonSlug = /[^a-z0-9]+/g
    private static readonly EdgeDashes = /^-+|-+$/g
    private static readonly FallbackSlug = 'role'
    private static readonly EmptyString = ''

    private readonly model: SecurityModelDto
    private readonly addedConcepts = new Set<string>()
    private readonly rolesAbsent: boolean
    private dirty = false

    public SelectedRoleId: string | undefined

    private constructor(model: SecurityModelDto)
    {
        this.model = model
        this.rolesAbsent = model.roles === undefined
        this.model.roles = this.model.roles ?? []
        this.SelectedRoleId = this.model.roles[0]?.id
    }

    public static From(model: SecurityModelDto | null): SecurityModelDraft
    {
        if (model === null || model === undefined)
        {
            return new SecurityModelDraft({
                businessUnits: [],
                teams: [],
                membership: { claimsMapping: [], overrides: [] },
                ownershipRules: [],
                roles: []
            })
        }
        return new SecurityModelDraft(SecurityModelDraft.Clone(model))
    }

    private static RoleId(slug: string, n: number): string
    {
        return `${SecurityModelDraft.RoleIdPrefix}${slug}${SecurityModelDraft.SlugSeparator}${n}`
    }

    private static Clone<T>(value: T): T
    {
        return structuredClone(value)
    }

    public get Roles(): readonly RoleConfigDto[]
    {
        return this.model.roles ?? []
    }

    public get Dirty(): boolean
    {
        return this.dirty
    }

    public get Concepts(): readonly string[]
    {
        const set = new Set<string>(this.addedConcepts)
        for (const role of this.Roles)
        {
            for (const p of role.privileges)
            {
                set.add(p.concept)
            }
        }
        for (const rule of this.model.ownershipRules ?? [])
        {
            set.add(rule.concept)
        }
        for (const f of this.model.fieldSecurity?.securedFields ?? [])
        {
            set.add(f.concept)
        }
        return [...set].sort()
    }

    public LevelFor(concept: string, action: PrivilegeAction): AccessLevel
    {
        const role = this.SelectedRole()
        const stored = role?.privileges.find(p => p.concept === concept && p.action === action)?.level
        return (LevelCycle as readonly string[]).includes(stored ?? SecurityModelDraft.EmptyString) ? stored as AccessLevel : AccessLevel.None
    }

    public SetLevel(concept: string, action: PrivilegeAction, level: AccessLevel): void
    {
        const role = this.SelectedRole()
        if (role === undefined)
        {
            return
        }
        const existing = role.privileges.findIndex(p => p.concept === concept && p.action === action)
        if (level === AccessLevel.None)
        {
            role.privileges = role.privileges.filter(p => !(p.concept === concept && p.action === action))
        }
        else if (existing >= 0)
        {
            role.privileges[existing].level = level
            role.privileges = role.privileges.filter((p, i) => i === existing || !(p.concept === concept && p.action === action))
        }
        else
        {
            const priv: PrivilegeDto = { action, concept, level }
            role.privileges.push(priv)
        }
        this.addedConcepts.add(concept)
        this.dirty = true
    }

    public CycleLevel(concept: string, action: PrivilegeAction): AccessLevel
    {
        const current = LevelCycle.indexOf(this.LevelFor(concept, action))
        const next = LevelCycle[(current + 1) % LevelCycle.length]
        this.SetLevel(concept, action, next)
        return next
    }

    public AddRole(name: string): string
    {
        const roles = this.model.roles ?? (this.model.roles = [])
        const slug = name.toLowerCase().replace(SecurityModelDraft.NonSlug, SecurityModelDraft.SlugSeparator)
            .replace(SecurityModelDraft.EdgeDashes, SecurityModelDraft.EmptyString) || SecurityModelDraft.FallbackSlug
        let n = 1
        while (roles.some(r => r.id === SecurityModelDraft.RoleId(slug, n)))
        {
            n++
        }
        const id = SecurityModelDraft.RoleId(slug, n)
        roles.push({ id, name, privileges: [] })
        this.SelectedRoleId = id
        this.dirty = true
        return id
    }

    public DeleteRole(id: string): void
    {
        const roles = this.model.roles ?? []
        const i = roles.findIndex(r => r.id === id)
        if (i < 0)
        {
            return
        }
        roles.splice(i, 1)
        if (this.SelectedRoleId === id)
        {
            this.SelectedRoleId = roles[0]?.id
        }
        this.dirty = true
    }

    public AddConcept(name: string): void
    {
        if (name.length === 0)
        {
            return
        }
        this.addedConcepts.add(name)
        this.dirty = true
    }

    public ToDto(): SecurityModelDto
    {
        const out = SecurityModelDraft.Clone(this.model)
        if (this.rolesAbsent && (out.roles?.length ?? 0) === 0)
        {
            delete out.roles
        }
        return out
    }

    private SelectedRole(): RoleConfigDto | undefined
    {
        return this.Roles.find(r => r.id === this.SelectedRoleId)
    }
}
