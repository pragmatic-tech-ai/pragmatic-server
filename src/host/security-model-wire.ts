import type { ProfileOverrideDto, RoleOverrideDto, SecurityModelDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AccessLevel, PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import type { IProfileOverrideConfig, IRoleOverrideConfig, ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { AdminEnumError } from './admin-enums.js'

/**
 * The C5 security setting between the wire (`SecurityModelDto`) and the identity config (`ISecurityModelConfig`):
 * explicit field copies, no casts. `FromDto` maps the C1 action and level strings fail closed (AdminEnumError naming
 * the field) and refuses a section that is not an array of objects; the entries' fields are S3's
 * `SecurityModelValidator`'s to judge, so a malformed field is copied as given and refused there.
 */
export class SecurityModelWire
{
    private static readonly ModelField = 'securityModel'
    private static readonly BusinessUnitsField = 'securityModel.businessUnits'
    private static readonly UsersField = 'securityModel.users'
    private static readonly TeamsField = 'securityModel.teams'
    private static readonly RoleAssignmentsField = 'securityModel.roleAssignments'
    private static readonly ProfileAssignmentsField = 'securityModel.profileAssignments'
    private static readonly RoleOverridesField = 'securityModel.roleOverrides'
    private static readonly ProfileOverridesField = 'securityModel.profileOverrides'
    private static readonly ActionField = 'securityModel.roleOverrides.action'
    private static readonly LevelField = 'securityModel.roleOverrides.level'
    private static readonly Actions: ReadonlyMap<string, PrivilegeAction> = new Map(Object.values(PrivilegeAction).map(action => [action as string, action]))
    private static readonly Levels: ReadonlyMap<string, AccessLevel> = new Map(Object.values(AccessLevel).map(level => [level as string, level]))

    public static ToDto(config: ISecurityModelConfig): SecurityModelDto
    {
        return {
            businessUnits: config.businessUnits.map(u => (u.parent === undefined ? { id: u.id, name: u.name } : { id: u.id, name: u.name, parent: u.parent })),
            users: config.users.map(u => ({ principalId: u.principalId, businessUnitId: u.businessUnitId })),
            teams: config.teams.map(t => ({ id: t.id, name: t.name, businessUnitId: t.businessUnitId, idpGroups: [...t.idpGroups], manualMembers: [...t.manualMembers] })),
            roleAssignments: config.roleAssignments.map(a => ({ role: a.role, principalIds: [...a.principalIds], teamIds: [...a.teamIds] })),
            profileAssignments: config.profileAssignments.map(a => ({ profile: a.profile, principalIds: [...a.principalIds], teamIds: [...a.teamIds] })),
            roleOverrides: config.roleOverrides.map(o => ({ role: o.role, concept: o.concept, action: o.action, level: o.level })),
            profileOverrides: config.profileOverrides.map(o => SecurityModelWire.ProfileOverride(o)),
        }
    }

    /** Throws AdminEnumError on an unknown action or level, or on a section that is not an array of objects. */
    public static FromDto(dto: SecurityModelDto): ISecurityModelConfig
    {
        const w = SecurityModelWire
        if (!w.IsRecord(dto)) throw new AdminEnumError(w.ModelField)
        return {
            businessUnits: w.Entries(dto.businessUnits, w.BusinessUnitsField).map(u => (u.parent === undefined ? { id: u.id, name: u.name } : { id: u.id, name: u.name, parent: u.parent })),
            users: w.Entries(dto.users, w.UsersField).map(u => ({ principalId: u.principalId, businessUnitId: u.businessUnitId })),
            teams: w.Entries(dto.teams, w.TeamsField).map(t => ({ id: t.id, name: t.name, businessUnitId: t.businessUnitId, idpGroups: t.idpGroups, manualMembers: t.manualMembers })),
            roleAssignments: w.Entries(dto.roleAssignments, w.RoleAssignmentsField).map(a => ({ role: a.role, principalIds: a.principalIds, teamIds: a.teamIds })),
            profileAssignments: w.Entries(dto.profileAssignments, w.ProfileAssignmentsField).map(a => ({ profile: a.profile, principalIds: a.principalIds, teamIds: a.teamIds })),
            roleOverrides: w.Entries(dto.roleOverrides, w.RoleOverridesField).map(o => w.RoleOverride(o)),
            profileOverrides: w.Entries(dto.profileOverrides, w.ProfileOverridesField).map(o => w.ProfileOverride(o)),
        }
    }

    /** `value` when it is an array of objects; the entries' fields are the structural validator's to judge. */
    private static Entries<T>(value: readonly T[] | undefined, field: string): readonly T[]
    {
        if (!Array.isArray(value) || !value.every(entry => SecurityModelWire.IsRecord(entry))) throw new AdminEnumError(field)
        return value
    }

    private static IsRecord(value: unknown): boolean
    {
        return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    private static RoleOverride(o: RoleOverrideDto): IRoleOverrideConfig
    {
        return { role: o.role, concept: o.concept, action: SecurityModelWire.Lookup(SecurityModelWire.Actions, o.action, SecurityModelWire.ActionField), level: SecurityModelWire.Lookup(SecurityModelWire.Levels, o.level, SecurityModelWire.LevelField) }
    }

    private static ProfileOverride(o: IProfileOverrideConfig | ProfileOverrideDto): ProfileOverrideDto
    {
        return { profile: o.profile, concept: o.concept, field: o.field, read: o.read, update: o.update, create: o.create }
    }

    private static Lookup<T>(table: ReadonlyMap<string, T>, value: unknown, field: string): T
    {
        const found = typeof value === 'string' ? table.get(value) : undefined
        if (found === undefined) throw new AdminEnumError(field)
        return found
    }
}
