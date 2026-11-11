import { SecurityRoleKind, TeamMemberOrigin } from '../../../tenant-types.js'
import type { FieldAccess } from './security-overrides.js'
import { AccessLevel, Actions, PrivilegeAction } from './security-model-enums.js'

// The words the security-model editor shows for levels and actions: each
// level's glyph and name, each action's column label, and the plain-language
// sentence summarising what a role can do with one concept.
export class SecurityModelText
{
    private static readonly NoneSymbol = '\u25cb'
    private static readonly UserSymbol = '\u25d4'
    private static readonly BusinessUnitSymbol = '\u25d1'
    private static readonly BusinessUnitAndChildrenSymbol = '\u25d5'
    private static readonly OrganizationSymbol = '\u25cf'
    private static readonly NoneName = 'None'
    private static readonly UserName = 'User'
    private static readonly BusinessUnitName = 'Business unit'
    private static readonly BusinessUnitAndChildrenName = 'Business unit and children'
    private static readonly OrganizationName = 'Organization'

    private static readonly NoAccessSentence = "Can't see or change this."
    private static readonly SentenceStart = 'Can '
    private static readonly SentenceEnd = '.'
    private static readonly AtWord = ' at '
    private static readonly LevelWord = ' level'
    private static readonly AndWord = ' and '
    private static readonly CommaSpace = ', '
    private static readonly CommaAndSpace = ', and '
    private static readonly CreateVerb = 'create'
    private static readonly ReadVerb = 'read'
    private static readonly UpdateVerb = 'update'
    private static readonly DeleteVerb = 'delete'
    private static readonly AppendVerb = 'append'
    private static readonly AppendToVerb = 'append to'
    private static readonly AssignVerb = 'assign'
    private static readonly ShareVerb = 'share'
    private static readonly InvokeVerb = 'invoke'
    private static readonly UserScope = 'user'
    private static readonly BusinessUnitScope = 'business unit'
    private static readonly BusinessUnitAndChildrenScope = 'business unit and children'
    private static readonly OrganizationScope = 'organization'
    private static readonly LegendSeparator = ' = '
    public static readonly DefaultPrefix = 'Default: '
    private static readonly FieldNoneName = 'no access'
    private static readonly FieldReadName = 'read'
    private static readonly FieldUpdateName = 'update'
    private static readonly FieldCreateName = 'create'
    public static readonly SystemAdministratorText = 'Full access to every record and field in this environment. Not editable.'
    private static readonly BaseRoleKindText = 'Base role'
    private static readonly PackageRoleKindText = 'Package role'
    private static readonly NoPackageText = ''
    private static readonly SyncedText = 'From identity provider'
    private static readonly ManualText = 'Added here'
    private static readonly UnsavedManualText = 'Added here (not saved)'

    // The security change log: one plain sentence per change.
    public static readonly NoChangesText = 'No deploy has changed security in this environment.'
    private static readonly RoleDefaultTemplate = '{role}: {action} on {concept} changed from {before} to {after}'
    private static readonly ProfileDefaultTemplate = '{profile}: access to {concept}.{field} changed from {before} to {after}'
    private static readonly SecuredFieldAddedTemplate = '{concept}.{field} is now secured: only people whose field profile grants it can read it'
    private static readonly SecuredFieldRemovedTemplate = '{concept}.{field} is no longer secured: everyone who can read the record can read it'
    private static readonly RoleOverrideDroppedTemplate = '{role}: your override of {action} on {concept} was dropped'
    private static readonly ProfileOverrideDroppedTemplate = '{profile}: your override of {concept}.{field} was dropped'
    private static readonly RoleRemovedTemplate = 'Role {role} was removed with its assignments'
    private static readonly ProfileRemovedTemplate = 'Profile {profile} was removed with its assignments'
    private static readonly ChangeHeadingTemplate = '{delivery} {version}, {time}'
    private static readonly UtcSuffix = ' UTC'
    private static readonly NotListedText = 'not listed'
    private static readonly TimePrefixLength = 16
    private static readonly IsoTimeSeparator = 'T'
    private static readonly SpaceText = ' '
    private static readonly PlaceholderPattern = /\{(\w+)\}/g

    private static readonly Symbols: ReadonlyMap<AccessLevel, string> = new Map<AccessLevel, string>([
        [AccessLevel.None, SecurityModelText.NoneSymbol],
        [AccessLevel.User, SecurityModelText.UserSymbol],
        [AccessLevel.BusinessUnit, SecurityModelText.BusinessUnitSymbol],
        [AccessLevel.BusinessUnitAndChildren, SecurityModelText.BusinessUnitAndChildrenSymbol],
        [AccessLevel.Organization, SecurityModelText.OrganizationSymbol],
    ])

    private static readonly LevelNames: ReadonlyMap<AccessLevel, string> = new Map<AccessLevel, string>([
        [AccessLevel.None, SecurityModelText.NoneName],
        [AccessLevel.User, SecurityModelText.UserName],
        [AccessLevel.BusinessUnit, SecurityModelText.BusinessUnitName],
        [AccessLevel.BusinessUnitAndChildren, SecurityModelText.BusinessUnitAndChildrenName],
        [AccessLevel.Organization, SecurityModelText.OrganizationName],
    ])

    private static readonly ActionVerbs: ReadonlyMap<PrivilegeAction, string> = new Map<PrivilegeAction, string>([
        [PrivilegeAction.Create, SecurityModelText.CreateVerb],
        [PrivilegeAction.Read, SecurityModelText.ReadVerb],
        [PrivilegeAction.Update, SecurityModelText.UpdateVerb],
        [PrivilegeAction.Delete, SecurityModelText.DeleteVerb],
        [PrivilegeAction.Append, SecurityModelText.AppendVerb],
        [PrivilegeAction.AppendTo, SecurityModelText.AppendToVerb],
        [PrivilegeAction.Assign, SecurityModelText.AssignVerb],
        [PrivilegeAction.Share, SecurityModelText.ShareVerb],
        [PrivilegeAction.Invoke, SecurityModelText.InvokeVerb],
    ])

    private static readonly LevelScopes: ReadonlyMap<AccessLevel, string> = new Map<AccessLevel, string>([
        [AccessLevel.User, SecurityModelText.UserScope],
        [AccessLevel.BusinessUnit, SecurityModelText.BusinessUnitScope],
        [AccessLevel.BusinessUnitAndChildren, SecurityModelText.BusinessUnitAndChildrenScope],
        [AccessLevel.Organization, SecurityModelText.OrganizationScope],
    ])

    public static Glyph(level: AccessLevel): string
    {
        return SecurityModelText.Symbols.get(level) ?? SecurityModelText.NoneSymbol
    }

    public static LevelName(level: AccessLevel): string
    {
        return SecurityModelText.LevelNames.get(level) ?? SecurityModelText.NoneName
    }

    // A catalog role's kind, in words.
    public static RoleKindText(kind: SecurityRoleKind): string
    {
        return kind === SecurityRoleKind.Package ? SecurityModelText.PackageRoleKindText : SecurityModelText.BaseRoleKindText
    }

    // The package declaring a catalog role ('' for a base role).
    public static RolePackageText(pkg: string | undefined): string
    {
        return pkg ?? SecurityModelText.NoPackageText
    }

    // The catalog default of a secured field, in words ("Default: read, update").
    public static FieldDefaultText(access: FieldAccess): string
    {
        return SecurityModelText.DefaultPrefix + SecurityModelText.FieldAccessNames(access)
    }

    // A field access as its permission names ("read, update"; "no access" when none).
    private static FieldAccessNames(access: FieldAccess): string
    {
        const names: string[] = []
        if (access.Read)
        {
            names.push(SecurityModelText.FieldReadName)
        }
        if (access.Update)
        {
            names.push(SecurityModelText.FieldUpdateName)
        }
        if (access.Create)
        {
            names.push(SecurityModelText.FieldCreateName)
        }
        return names.length === 0 ? SecurityModelText.FieldNoneName : names.join(SecurityModelText.CommaSpace)
    }

    // One legend line: the glyph, then the level's name.
    public static LegendLine(level: AccessLevel): string
    {
        return SecurityModelText.Glyph(level) + SecurityModelText.LegendSeparator + SecurityModelText.LevelName(level)
    }

    // Plain-language summary of what a role can do with one concept, given
    // the role's level per action.
    public static Sentence(levelOf: (action: PrivilegeAction) => AccessLevel): string
    {
        const parts: string[] = []
        for (const action of Actions)
        {
            const scope = SecurityModelText.LevelScopes.get(levelOf(action))
            if (scope !== undefined)
            {
                parts.push((SecurityModelText.ActionVerbs.get(action) ?? action) + SecurityModelText.AtWord + scope + SecurityModelText.LevelWord)
            }
        }
        if (parts.length === 0)
        {
            return SecurityModelText.NoAccessSentence
        }
        return SecurityModelText.SentenceStart + SecurityModelText.JoinParts(parts) + SecurityModelText.SentenceEnd
    }

    // Where a team member comes from: the identity provider, or added in this editor
    // (saved or not yet).
    public static MemberOrigin(origin: TeamMemberOrigin, unsaved: boolean): string
    {
        if (origin === TeamMemberOrigin.Synced)
        {
            return SecurityModelText.SyncedText
        }
        return unsaved ? SecurityModelText.UnsavedManualText : SecurityModelText.ManualText
    }

    // The heading of one change-log entry: the delivery, its version and the UTC time (never locale-dependent).
    public static ChangeHeading(delivery: string, version: string, at: string): string
    {
        return SecurityModelText.Fill(SecurityModelText.ChangeHeadingTemplate, { delivery, version, time: SecurityModelText.UtcTime(at) })
    }

    public static RoleDefaultChange(role: string, concept: string, action: string, before: string, after: string): string
    {
        return SecurityModelText.Fill(SecurityModelText.RoleDefaultTemplate, {
            role, concept, action: SecurityModelText.ActionName(action), before: SecurityModelText.LevelNameOf(before), after: SecurityModelText.LevelNameOf(after),
        })
    }

    public static ProfileDefaultChange(profile: string, concept: string, field: string, before: FieldAccess | null, after: FieldAccess | null): string
    {
        return SecurityModelText.Fill(SecurityModelText.ProfileDefaultTemplate, {
            profile, concept, field, before: SecurityModelText.FieldAccessText(before), after: SecurityModelText.FieldAccessText(after),
        })
    }

    public static SecuredFieldAdded(concept: string, field: string): string
    {
        return SecurityModelText.Fill(SecurityModelText.SecuredFieldAddedTemplate, { concept, field })
    }

    public static SecuredFieldRemoved(concept: string, field: string): string
    {
        return SecurityModelText.Fill(SecurityModelText.SecuredFieldRemovedTemplate, { concept, field })
    }

    public static RoleOverrideDropped(role: string, concept: string, action: string): string
    {
        return SecurityModelText.Fill(SecurityModelText.RoleOverrideDroppedTemplate, { role, concept, action: SecurityModelText.ActionName(action) })
    }

    public static ProfileOverrideDropped(profile: string, concept: string, field: string): string
    {
        return SecurityModelText.Fill(SecurityModelText.ProfileOverrideDroppedTemplate, { profile, concept, field })
    }

    public static RoleRemoved(role: string): string
    {
        return SecurityModelText.Fill(SecurityModelText.RoleRemovedTemplate, { role })
    }

    public static ProfileRemoved(profile: string): string
    {
        return SecurityModelText.Fill(SecurityModelText.ProfileRemovedTemplate, { profile })
    }

    // Fills every {name} placeholder from `values`; an unknown placeholder stays as written.
    private static Fill(template: string, values: Readonly<Record<string, string>>): string
    {
        return template.replace(SecurityModelText.PlaceholderPattern, (whole, name: string) => values[name] ?? whole)
    }

    private static UtcTime(at: string): string
    {
        const ms = Date.parse(at)
        if (Number.isNaN(ms))
        {
            return at
        }
        return new Date(ms).toISOString().slice(0, SecurityModelText.TimePrefixLength).replace(SecurityModelText.IsoTimeSeparator, SecurityModelText.SpaceText) + SecurityModelText.UtcSuffix
    }

    private static ActionName(action: string): string
    {
        return SecurityModelText.ActionVerbs.get(action as PrivilegeAction) ?? action
    }

    private static LevelNameOf(level: string): string
    {
        return SecurityModelText.LevelNames.get(level as AccessLevel) ?? level
    }

    private static FieldAccessText(access: FieldAccess | null): string
    {
        if (access === null)
        {
            return SecurityModelText.NotListedText
        }
        return SecurityModelText.FieldAccessNames(access)
    }

    private static JoinParts(parts: readonly string[]): string
    {
        if (parts.length === 1)
        {
            return parts[0]
        }
        if (parts.length === 2)
        {
            return parts[0] + SecurityModelText.AndWord + parts[1]
        }
        const head = parts.slice(0, parts.length - 1).join(SecurityModelText.CommaSpace)
        return head + SecurityModelText.CommaAndSpace + parts[parts.length - 1]
    }
}
