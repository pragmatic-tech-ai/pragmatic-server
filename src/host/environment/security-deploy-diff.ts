import type { IEnvironmentCatalog } from '@pragmatic-tech-ai/todl/engine'
import { AccessLevel } from '@pragmatic-tech-ai/todl-identity'
import type { IProfileAssignmentConfig, IProfileOverrideConfig, IRoleAssignmentConfig, IRoleOverrideConfig, ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import type { TenantSecurityModel } from '@pragmatic-tech-ai/todl-identity-engine'
import type { FieldAccessDto, ProfileAssignmentDto, ProfileDefaultChangeDto, ProfileOverrideDto, RoleAssignmentDto, RoleDefaultChangeDto, RoleOverrideDto, SecuredFieldDto, SecurityCatalogDto, SecurityChangesDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { SecurityCatalogReader } from './security-catalog-reader.js'
import { SecuritySettingCatalogCheck } from './security-setting-catalog-check.js'

/** What a deploy's security changes are, without the entry's time, delivery and version. */
export type SecurityDiffChanges = Omit<SecurityChangesDto, 'at' | 'delivery' | 'version'>

/** One role's default depth for one action on one concept. */
interface IRoleLevel
{
    readonly role: string
    readonly concept: string
    readonly action: string
    readonly level: string
}

/** One profile's default rights on one secured field. */
interface IProfileRight
{
    readonly profile: string
    readonly access: FieldAccessDto
}

/** The setting entries the prospective packages cannot mean (the entries `Pruned` removes). */
class DroppedEntries
{
    public readonly RoleOverrides = new Set<IRoleOverrideConfig>()
    public readonly ProfileOverrides = new Set<IProfileOverrideConfig>()
    public readonly RoleAssignments = new Set<IRoleAssignmentConfig>()
    public readonly ProfileAssignments = new Set<IProfileAssignmentConfig>()

    /** Exactly the entries the catalog check reports with a prunable code (SecuritySettingCatalogCheck.EntriesOf). */
    public static Of(setting: ISecurityModelConfig, prospective: IEnvironmentCatalog, model: TenantSecurityModel): DroppedEntries
    {
        const dropped = new DroppedEntries()
        for (const issue of SecuritySettingCatalogCheck.Issues(setting, prospective, model))
        {
            const entries = SecuritySettingCatalogCheck.EntriesOf(issue, setting)
            for (const entry of entries.RoleOverrides) dropped.RoleOverrides.add(entry)
            for (const entry of entries.ProfileOverrides) dropped.ProfileOverrides.add(entry)
            for (const entry of entries.RoleAssignments) dropped.RoleAssignments.add(entry)
            for (const entry of entries.ProfileAssignments) dropped.ProfileAssignments.add(entry)
        }
        return dropped
    }

    public get IsEmpty(): boolean
    {
        return this.RoleOverrides.size + this.ProfileOverrides.size + this.RoleAssignments.size + this.ProfileAssignments.size === 0
    }
}

/**
 * The security a deploy or promote changes (S4 Task 13, PR14): computed from the running catalog and the prospective
 * one (both read through SecurityCatalogReader, so the defaults compared are exactly the ones the admin edits against:
 * package roles and the base-role contribution unions, max depth per (concept, action)).
 *
 * - Role defaults per (role, concept, action), absent = `none`; profile defaults per (profile, concept, field), absent = null.
 * - Secured fields added and removed.
 * - Dropped overrides and removed assignments: exactly the entries `SecuritySettingCatalogCheck.Issues(setting,
 *   prospective, model)` reports with UnknownRole, UnknownProfile, UnknownConcept, ExternalConcept,
 *   OrganizationOwnedDepth or UnsecuredField (`SecuritySettingCatalogCheck.EntriesOf`). `Pruned` removes those
 *   entries (by value) and nothing else, so an entry the deploy dropped stays dropped when a later deploy brings its
 *   concept or role back (Review Focus 1). `Rebased` recomputes them over a setting re-read at commit time.
 * - `NewlyOwned`: the prospective owned concepts the running catalog describes without the ownership aspect (their
 *   live records get the system principal as owner, PR16).
 */
export class SecurityDeployDiff
{
    private static readonly KeySeparator = '\u0000'

    private constructor(
        public readonly Current: IEnvironmentCatalog,
        public readonly Prospective: IEnvironmentCatalog,
        public readonly Changes: SecurityDiffChanges,
        public readonly NewlyOwned: readonly string[],
        private readonly dropped: DroppedEntries)
    {
    }

    public static Compute(current: IEnvironmentCatalog, prospective: IEnvironmentCatalog, setting: ISecurityModelConfig | undefined, model: TenantSecurityModel): SecurityDeployDiff
    {
        const before = SecurityCatalogReader.Read(current)
        const after = SecurityCatalogReader.Read(prospective)
        const dropped = setting === undefined ? new DroppedEntries() : DroppedEntries.Of(setting, prospective, model)
        const changes: SecurityDiffChanges = {
            roleDefaults: SecurityDeployDiff.RoleDefaults(before, after),
            profileDefaults: SecurityDeployDiff.ProfileDefaults(before, after),
            securedFieldsAdded: SecurityDeployDiff.FieldsMissing(after.securedFields, before.securedFields),
            securedFieldsRemoved: SecurityDeployDiff.FieldsMissing(before.securedFields, after.securedFields),
            roleOverridesDropped: [...dropped.RoleOverrides].map(o => SecurityDeployDiff.RoleOverride(o)),
            profileOverridesDropped: [...dropped.ProfileOverrides].map(o => SecurityDeployDiff.ProfileOverride(o)),
            rolesRemoved: [...dropped.RoleAssignments].map(a => SecurityDeployDiff.RoleAssignment(a)),
            profilesRemoved: [...dropped.ProfileAssignments].map(a => SecurityDeployDiff.ProfileAssignment(a)),
        }
        return new SecurityDeployDiff(current, prospective, changes, SecurityDeployDiff.NewlyOwnedOf(current, prospective), dropped)
    }

    /**
     * True when the deploy changes nothing the change log shows. An upgrade that only adds the ownership aspect is
     * empty here: it is backfilled (`NewlyOwned`) without a change-log entry; a failed backfill is reported, a
     * successful one is silent (ruling R37).
     */
    public get IsEmpty(): boolean
    {
        return Object.values(this.Changes).every((list: readonly unknown[]) => list.length === 0)
    }

    /** True when `Pruned` changes a setting that holds the dropped entries. */
    public get Prunes(): boolean
    {
        return !this.dropped.IsEmpty
    }

    /** The same delivery's diff over `setting` as stored now (the commit re-reads it: an admin save may have landed). */
    public Rebased(setting: ISecurityModelConfig | undefined, model: TenantSecurityModel): SecurityDeployDiff
    {
        return SecurityDeployDiff.Compute(this.Current, this.Prospective, setting, model)
    }

    /** `setting` without the dropped entries (matched by value, so a re-read of the same setting prunes the same). */
    public Pruned(setting: ISecurityModelConfig): ISecurityModelConfig
    {
        const roleOverrides = SecurityDeployDiff.Keys(this.Changes.roleOverridesDropped)
        const profileOverrides = SecurityDeployDiff.Keys(this.Changes.profileOverridesDropped)
        const roleAssignments = SecurityDeployDiff.Keys(this.Changes.rolesRemoved)
        const profileAssignments = SecurityDeployDiff.Keys(this.Changes.profilesRemoved)
        return {
            ...setting,
            roleOverrides: setting.roleOverrides.filter(o => !roleOverrides.has(SecurityDeployDiff.Key(SecurityDeployDiff.RoleOverride(o)))),
            profileOverrides: setting.profileOverrides.filter(o => !profileOverrides.has(SecurityDeployDiff.Key(SecurityDeployDiff.ProfileOverride(o)))),
            roleAssignments: setting.roleAssignments.filter(a => !roleAssignments.has(SecurityDeployDiff.Key(SecurityDeployDiff.RoleAssignment(a)))),
            profileAssignments: setting.profileAssignments.filter(a => !profileAssignments.has(SecurityDeployDiff.Key(SecurityDeployDiff.ProfileAssignment(a)))),
        }
    }

    private static RoleDefaults(before: SecurityCatalogDto, after: SecurityCatalogDto): RoleDefaultChangeDto[]
    {
        const was = SecurityDeployDiff.RoleLevels(before)
        const now = SecurityDeployDiff.RoleLevels(after)
        const changes: RoleDefaultChangeDto[] = []
        for (const key of [...new Set([...was.keys(), ...now.keys()])].sort())
        {
            const from = was.get(key)?.level ?? AccessLevel.None
            const to = now.get(key)?.level ?? AccessLevel.None
            if (from === to) continue
            const { role, concept, action } = (now.get(key) ?? was.get(key))!
            changes.push({ role, concept, action, before: from, after: to })
        }
        return changes
    }

    private static RoleLevels(catalog: SecurityCatalogDto): Map<string, IRoleLevel>
    {
        const levels = new Map<string, IRoleLevel>()
        for (const role of catalog.roles)
        {
            for (const privilege of role.defaults)
            {
                const key = [role.name, privilege.concept, privilege.action].join(SecurityDeployDiff.KeySeparator)
                levels.set(key, { role: role.name, concept: privilege.concept, action: privilege.action, level: privilege.level })
            }
        }
        return levels
    }

    private static ProfileDefaults(before: SecurityCatalogDto, after: SecurityCatalogDto): ProfileDefaultChangeDto[]
    {
        const was = SecurityDeployDiff.ProfileRights(before)
        const now = SecurityDeployDiff.ProfileRights(after)
        const changes: ProfileDefaultChangeDto[] = []
        for (const key of [...new Set([...was.keys(), ...now.keys()])].sort())
        {
            const from = was.get(key)
            const to = now.get(key)
            if (from !== undefined && to !== undefined && SecurityDeployDiff.SameRights(from.access, to.access)) continue
            const { profile, access } = (to ?? from)!
            changes.push({ profile, concept: access.concept, field: access.field, before: from?.access ?? null, after: to?.access ?? null })
        }
        return changes
    }

    private static ProfileRights(catalog: SecurityCatalogDto): Map<string, IProfileRight>
    {
        const rights = new Map<string, IProfileRight>()
        for (const profile of catalog.profiles)
        {
            for (const access of profile.defaults)
            {
                rights.set([profile.name, access.concept, access.field].join(SecurityDeployDiff.KeySeparator), { profile: profile.name, access })
            }
        }
        return rights
    }

    private static SameRights(a: FieldAccessDto, b: FieldAccessDto): boolean
    {
        return a.read === b.read && a.update === b.update && a.create === b.create
    }

    /** The fields of `of` not in `from`. */
    private static FieldsMissing(of: readonly SecuredFieldDto[], from: readonly SecuredFieldDto[]): SecuredFieldDto[]
    {
        const present = new Set(from.map(field => field.concept + SecurityDeployDiff.KeySeparator + field.field))
        return of.filter(field => !present.has(field.concept + SecurityDeployDiff.KeySeparator + field.field))
    }

    private static NewlyOwnedOf(current: IEnvironmentCatalog, prospective: IEnvironmentCatalog): string[]
    {
        const described = new Set(current.Description.Definitions.map(definition => definition.Name))
        const owned = current.Security.OwnedConcepts()
        return [...prospective.Security.OwnedConcepts()].filter(concept => described.has(concept) && !owned.has(concept)).sort()
    }

    private static RoleOverride(o: IRoleOverrideConfig): RoleOverrideDto
    {
        return { role: o.role, concept: o.concept, action: o.action, level: o.level }
    }

    private static ProfileOverride(o: IProfileOverrideConfig): ProfileOverrideDto
    {
        return { profile: o.profile, concept: o.concept, field: o.field, read: o.read, update: o.update, create: o.create }
    }

    private static RoleAssignment(a: IRoleAssignmentConfig): RoleAssignmentDto
    {
        return { role: a.role, principalIds: [...a.principalIds], teamIds: [...a.teamIds] }
    }

    private static ProfileAssignment(a: IProfileAssignmentConfig): ProfileAssignmentDto
    {
        return { profile: a.profile, principalIds: [...a.principalIds], teamIds: [...a.teamIds] }
    }

    private static Keys(entries: readonly object[]): ReadonlySet<string>
    {
        return new Set(entries.map(entry => SecurityDeployDiff.Key(entry)))
    }

    /** A value key of one entry (its DTO copy, whose fields are always written in one order). */
    private static Key(entry: object): string
    {
        return JSON.stringify(entry)
    }
}
