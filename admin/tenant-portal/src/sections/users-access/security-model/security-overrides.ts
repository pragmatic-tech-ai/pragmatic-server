import type { FieldAccessDto, ProfileOverrideDto, RoleOverrideDto, SecurityCatalogDto, SecurityModelDto } from '../../../tenant-types.js'
import { AccessLevel, FieldPermission, LevelCycle, PrivilegeAction } from './security-model-enums.js'

// One secured field's access for a field profile: read, update, create.
export class FieldAccess
{
    public static readonly None = new FieldAccess(false, false, false)

    public constructor(public readonly Read: boolean, public readonly Update: boolean, public readonly Create: boolean)
    {
    }

    public static From(dto: { read: boolean; update: boolean; create: boolean }): FieldAccess
    {
        return new FieldAccess(dto.read === true, dto.update === true, dto.create === true)
    }

    public Has(permission: FieldPermission): boolean
    {
        switch (permission)
        {
            case FieldPermission.Read:
                return this.Read
            case FieldPermission.Update:
                return this.Update
            case FieldPermission.Create:
                return this.Create
        }
    }

    // This access with one permission set to `value`.
    public With(permission: FieldPermission, value: boolean): FieldAccess
    {
        return new FieldAccess(
            permission === FieldPermission.Read ? value : this.Read,
            permission === FieldPermission.Update ? value : this.Update,
            permission === FieldPermission.Create ? value : this.Create)
    }

    public Equals(other: FieldAccess): boolean
    {
        return this.Read === other.Read && this.Update === other.Update && this.Create === other.Create
    }
}

// The setting's role and profile overrides over the catalog's defaults. An
// override equal to its default is never stored: setting one removes the row.
// Rows naming a role, concept or profile the catalog lacks are left untouched
// (the server prunes them on deploy). Edits the live model in place.
export class SecurityOverrides
{
    private static readonly OrganizationOwnedLevels: readonly AccessLevel[] = [AccessLevel.None, AccessLevel.Organization]

    private dirty = false

    public constructor(private readonly model: SecurityModelDto, private readonly catalog: SecurityCatalogDto)
    {
    }

    public get Dirty(): boolean
    {
        return this.dirty
    }

    // ---- Role privileges -----------------------------------------------

    public DefaultLevel(role: string, concept: string, action: PrivilegeAction): AccessLevel
    {
        const privilege = this.catalog.roles.find(r => r.name === role)?.defaults.find(p => p.concept === concept && p.action === action)
        return SecurityOverrides.LevelOf(privilege?.level) ?? AccessLevel.None
    }

    public OverrideLevel(role: string, concept: string, action: PrivilegeAction): AccessLevel | undefined
    {
        return SecurityOverrides.LevelOf(this.FindRoleOverride(role, concept, action)?.level)
    }

    public EffectiveLevel(role: string, concept: string, action: PrivilegeAction): AccessLevel
    {
        return this.OverrideLevel(role, concept, action) ?? this.DefaultLevel(role, concept, action)
    }

    // Stores `level` as an override; equal to the default, the override is removed.
    public SetLevel(role: string, concept: string, action: PrivilegeAction, level: AccessLevel): void
    {
        if (level === this.DefaultLevel(role, concept, action))
        {
            this.Reset(role, concept, action)
            return
        }
        const existing = this.FindRoleOverride(role, concept, action)
        if (existing === undefined)
        {
            const row: RoleOverrideDto = { role, concept, action, level }
            this.model.roleOverrides.push(row)
            this.dirty = true
        }
        else if (existing.level !== level)
        {
            existing.level = level
            this.dirty = true
        }
    }

    public Reset(role: string, concept: string, action: PrivilegeAction): void
    {
        const before = this.model.roleOverrides.length
        this.model.roleOverrides = this.model.roleOverrides.filter(r => !SecurityOverrides.IsRoleRow(r, role, concept, action))
        this.dirty ||= this.model.roleOverrides.length !== before
    }

    // An organisation-owned concept (no ownership aspect) has no owner or
    // owning unit, so a role reaches it at Organization depth or not at all.
    public IsOrganizationOwned(concept: string): boolean
    {
        const known = this.catalog.concepts.find(c => c.name === concept)
        return known !== undefined && !known.owned
    }

    public AllowedLevels(concept: string): readonly AccessLevel[]
    {
        return this.IsOrganizationOwned(concept) ? SecurityOverrides.OrganizationOwnedLevels : LevelCycle
    }

    // ---- Field profiles ------------------------------------------------

    public DefaultField(profile: string, concept: string, field: string): FieldAccess
    {
        const access = this.catalog.profiles.find(p => p.name === profile)?.defaults.find(d => d.concept === concept && d.field === field)
        return access === undefined ? FieldAccess.None : FieldAccess.From(access)
    }

    public OverrideField(profile: string, concept: string, field: string): FieldAccess | undefined
    {
        const row = this.FindProfileOverride(profile, concept, field)
        return row === undefined ? undefined : FieldAccess.From(row)
    }

    public EffectiveField(profile: string, concept: string, field: string): FieldAccess
    {
        return this.OverrideField(profile, concept, field) ?? this.DefaultField(profile, concept, field)
    }

    // Sets one permission on the effective access; equal to the default, the override is removed.
    public SetField(profile: string, concept: string, field: string, permission: FieldPermission, value: boolean): void
    {
        const next = this.EffectiveField(profile, concept, field).With(permission, value)
        if (next.Equals(this.DefaultField(profile, concept, field)))
        {
            this.ResetField(profile, concept, field)
            return
        }
        const existing = this.FindProfileOverride(profile, concept, field)
        if (existing === undefined)
        {
            const row: ProfileOverrideDto = { profile, concept, field, read: next.Read, update: next.Update, create: next.Create }
            this.model.profileOverrides.push(row)
            this.dirty = true
        }
        else if (!FieldAccess.From(existing).Equals(next))
        {
            existing.read = next.Read
            existing.update = next.Update
            existing.create = next.Create
            this.dirty = true
        }
    }

    public ResetField(profile: string, concept: string, field: string): void
    {
        const before = this.model.profileOverrides.length
        this.model.profileOverrides = this.model.profileOverrides.filter(r => !SecurityOverrides.IsProfileRow(r, profile, concept, field))
        this.dirty ||= this.model.profileOverrides.length !== before
    }

    // ---- Plumbing ------------------------------------------------------

    private FindRoleOverride(role: string, concept: string, action: PrivilegeAction): RoleOverrideDto | undefined
    {
        return this.model.roleOverrides.find(r => SecurityOverrides.IsRoleRow(r, role, concept, action))
    }

    private FindProfileOverride(profile: string, concept: string, field: string): ProfileOverrideDto | undefined
    {
        return this.model.profileOverrides.find(r => SecurityOverrides.IsProfileRow(r, profile, concept, field))
    }

    private static IsRoleRow(row: RoleOverrideDto, role: string, concept: string, action: PrivilegeAction): boolean
    {
        return row.role === role && row.concept === concept && row.action === action
    }

    private static IsProfileRow(row: ProfileOverrideDto, profile: string, concept: string, field: string): boolean
    {
        return row.profile === profile && row.concept === concept && row.field === field
    }

    // A wire level string as an AccessLevel; undefined when absent or not a level.
    private static LevelOf(level: string | undefined): AccessLevel | undefined
    {
        return level !== undefined && (LevelCycle as readonly string[]).includes(level) ? level as AccessLevel : undefined
    }
}
