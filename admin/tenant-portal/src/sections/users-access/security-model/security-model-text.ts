import { TeamMemberOrigin } from '../../../tenant-types.js'
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
    public static readonly SystemAdministratorText = 'Full access to every record and field in this environment. Not editable.'
    private static readonly SyncedText = 'From identity provider'
    private static readonly ManualText = 'Added here'
    private static readonly UnsavedManualText = 'Added here (not saved)'

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
