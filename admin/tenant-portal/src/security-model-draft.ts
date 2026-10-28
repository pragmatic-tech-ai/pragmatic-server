import { RecordSharingDeriver } from './record-sharing.js'
import type { RecordSharingRowData } from './record-sharing.js'
import { SecurityModelOrg } from './security-model-org.js'
import type { FieldGrantDto, FieldProfileDto, FieldSecurityDto, PrivilegeDto, RoleConfigDto, SecuredFieldDto, SecurityModelDto } from './tenant-types.js'

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
    private static readonly ProfileIdPrefix = 'profile-'
    private static readonly FallbackProfileSlug = 'profile'

    private readonly model: SecurityModelDto
    private readonly org: SecurityModelOrg
    private readonly addedConcepts = new Set<string>()
    private readonly rolesAbsent: boolean
    private readonly fieldSecurityAbsent: boolean
    private dirty = false

    public SelectedRoleId: string | undefined
    public SelectedProfileId: string | undefined

    private constructor(model: SecurityModelDto)
    {
        this.model = model
        this.org = new SecurityModelOrg(this.model)
        this.rolesAbsent = model.roles === undefined
        this.model.roles = this.model.roles ?? []
        this.SelectedRoleId = this.model.roles[0]?.id
        this.fieldSecurityAbsent = model.fieldSecurity === undefined
        this.SelectedProfileId = model.fieldSecurity?.profiles[0]?.id
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

    private static ProfileId(slug: string, n: number): string
    {
        return `${SecurityModelDraft.ProfileIdPrefix}${slug}${SecurityModelDraft.SlugSeparator}${n}`
    }

    private static Slug(name: string, fallback: string): string
    {
        return name.toLowerCase().replace(SecurityModelDraft.NonSlug, SecurityModelDraft.SlugSeparator)
            .replace(SecurityModelDraft.EdgeDashes, SecurityModelDraft.EmptyString) || fallback
    }

    private static Clone<T>(value: T): T
    {
        return structuredClone(value)
    }

    public get Roles(): readonly RoleConfigDto[]
    {
        return this.model.roles ?? []
    }

    public get Org(): SecurityModelOrg
    {
        return this.org
    }

    public get Dirty(): boolean
    {
        return this.dirty || this.org.Dirty
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
        const slug = SecurityModelDraft.Slug(name, SecurityModelDraft.FallbackSlug)
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

    public get SecuredFields(): readonly SecuredFieldDto[]
    {
        return this.model.fieldSecurity?.securedFields ?? []
    }

    public get Profiles(): readonly FieldProfileDto[]
    {
        return this.model.fieldSecurity?.profiles ?? []
    }

    public FieldGrant(concept: string, field: string, permission: FieldPermission): boolean
    {
        const grant = this.SelectedProfile()?.grants.find(g => g.concept === concept && g.field === field)
        return grant?.[permission] === true
    }

    public SetFieldGrant(concept: string, field: string, permission: FieldPermission, value: boolean): void
    {
        const profile = this.SelectedProfile()
        if (profile === undefined)
        {
            return
        }
        let grant = profile.grants.find(g => g.concept === concept && g.field === field)
        if (grant === undefined)
        {
            grant = { concept, field }
            profile.grants.push(grant)
        }
        grant[permission] = value
        if (!grant.read && !grant.update && !grant.create)
        {
            profile.grants = profile.grants.filter(g => !(g.concept === concept && g.field === field))
        }
        this.dirty = true
    }

    public AddProfile(name: string): string
    {
        const profiles = this.EnsureFieldSecurity().profiles
        const slug = SecurityModelDraft.Slug(name, SecurityModelDraft.FallbackProfileSlug)
        let n = 1
        while (profiles.some(p => p.id === SecurityModelDraft.ProfileId(slug, n)))
        {
            n++
        }
        const id = SecurityModelDraft.ProfileId(slug, n)
        profiles.push({ id, name, grants: [] })
        this.SelectedProfileId = id
        this.dirty = true
        return id
    }

    public DeleteProfile(id: string): void
    {
        const profiles = this.model.fieldSecurity?.profiles ?? []
        const i = profiles.findIndex(p => p.id === id)
        if (i < 0)
        {
            return
        }
        profiles.splice(i, 1)
        if (this.SelectedProfileId === id)
        {
            this.SelectedProfileId = profiles[0]?.id
        }
        this.dirty = true
    }

    public AddSecuredField(concept: string, field: string): void
    {
        const fs = this.EnsureFieldSecurity()
        if (fs.securedFields.some(f => f.concept === concept && f.field === field))
        {
            return
        }
        fs.securedFields.push({ concept, field })
        this.dirty = true
    }

    public RemoveSecuredField(concept: string, field: string): void
    {
        const fs = this.model.fieldSecurity
        if (fs === undefined)
        {
            return
        }
        fs.securedFields = fs.securedFields.filter(f => !(f.concept === concept && f.field === field))
        for (const profile of fs.profiles)
        {
            profile.grants = profile.grants.filter((g: FieldGrantDto) => !(g.concept === concept && g.field === field))
        }
        this.dirty = true
    }

    public RecordSharingFor(roleId: string): readonly RecordSharingRowData[]
    {
        const role = this.Roles.find(r => r.id === roleId)
        return RecordSharingDeriver.Rows(role, this.model.ownershipRules ?? [])
    }

    public ToDto(): SecurityModelDto
    {
        const out = SecurityModelDraft.Clone(this.model)
        if (this.fieldSecurityAbsent && out.fieldSecurity !== undefined
            && out.fieldSecurity.securedFields.length === 0 && out.fieldSecurity.profiles.length === 0)
        {
            delete out.fieldSecurity
        }
        if (this.rolesAbsent && (out.roles?.length ?? 0) === 0)
        {
            delete out.roles
        }
        return out
    }

    private EnsureFieldSecurity(): FieldSecurityDto
    {
        return this.model.fieldSecurity ?? (this.model.fieldSecurity = {
            securedFields: [],
            profiles: [],
            profileAssignment: { claimsMapping: [], overrides: [], teamProfiles: [] }
        })
    }

    private SelectedProfile(): FieldProfileDto | undefined
    {
        return this.Profiles.find(p => p.id === this.SelectedProfileId)
    }

    private SelectedRole(): RoleConfigDto | undefined
    {
        return this.Roles.find(r => r.id === this.SelectedRoleId)
    }
}
