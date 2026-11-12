import type { IEnvironmentCatalog } from '@pragmatic-tech-ai/todl/engine'
import { AccessLevel, BaseRole } from '@pragmatic-tech-ai/todl-identity'
import type { IProfileAssignmentConfig, IProfileOverrideConfig, IRoleAssignmentConfig, IRoleOverrideConfig, ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { Tier1Catalog, Tier1DiagnosticCode, Tier1ScopeCompiler } from '@pragmatic-tech-ai/todl-identity-engine'
import type { TenantSecurityModel } from '@pragmatic-tech-ai/todl-identity-engine'

/** Why an admin save of the security setting is refused against the deployed packages (Review Focus 2). */
export enum SecuritySettingIssueCode
{
    UnknownRole = 'UnknownRole',
    UnknownProfile = 'UnknownProfile',
    UnknownConcept = 'UnknownConcept',
    UnsecuredField = 'UnsecuredField',
    OrganizationOwnedDepth = 'OrganizationOwnedDepth',
    ExternalConcept = 'ExternalConcept',
    SystemAdministratorOverride = 'SystemAdministratorOverride',
}

/** One refused entry of the setting: its code, what it names, and the code's fixed reason. */
export class SecuritySettingIssue
{
    private static readonly Messages: Readonly<Record<SecuritySettingIssueCode, string>> = {
        [SecuritySettingIssueCode.UnknownRole]: 'the setting names a role no deployed package or the platform defines',
        [SecuritySettingIssueCode.UnknownProfile]: 'the setting names a field profile no deployed package defines',
        [SecuritySettingIssueCode.UnknownConcept]: 'a role override names a concept no deployed package stores in the environment graph',
        [SecuritySettingIssueCode.UnsecuredField]: 'a profile override names a field no deployed package secures',
        [SecuritySettingIssueCode.OrganizationOwnedDepth]: 'a concept without an owner takes only the none or organization depth',
        [SecuritySettingIssueCode.ExternalConcept]: 'connector data is outside platform security; it takes no overrides',
        [SecuritySettingIssueCode.SystemAdministratorOverride]: 'the System Administrator role is unrestricted and takes no overrides',
    }

    public constructor(public readonly Code: SecuritySettingIssueCode, public readonly Subject: string)
    {
    }

    public get Message(): string
    {
        return SecuritySettingIssue.Messages[this.Code]
    }
}

/** The entries of a setting one issue names (what a deploy prunes for it, S4 Task 13). */
export class SecuritySettingEntries
{
    public constructor(
        public readonly RoleOverrides: readonly IRoleOverrideConfig[],
        public readonly ProfileOverrides: readonly IProfileOverrideConfig[],
        public readonly RoleAssignments: readonly IRoleAssignmentConfig[],
        public readonly ProfileAssignments: readonly IProfileAssignmentConfig[])
    {
    }
}

/**
 * The semantic check of a security setting against an environment's deployed packages, run by the admin save before the
 * setting is stored (S3's `SecurityModelValidator` stays the structural check). S3's compiler tolerates these entries
 * (it drops them with a diagnostic); the save refuses them so the admin sees why.
 *
 * From `Tier1ScopeCompiler.Diagnose`: UnknownAssignedRole / OverrideUnknownRole → UnknownRole; UnknownAssignedProfile /
 * OverrideUnknownProfile → UnknownProfile; OverrideUnknownConcept → UnknownConcept (or ExternalConcept for a concept the
 * environment describes but a connector holds); OverridePlatformConcept → UnknownConcept (the platform vocabulary's rules
 * are fixed); OverrideUnknownField → UnsecuredField; NonOrganizationDepthOnUnownedConcept → OrganizationOwnedDepth.
 * Besides: a role or profile override on a concept outside `Tier1Catalog.EngineStoredConcepts` → ExternalConcept, and
 * any role override of `BaseRole.SystemAdministrator` → SystemAdministratorOverride. An unplaced principal holding roles
 * is not an issue (it sits at the root, C7). A profile override may target any package's secured field (PR15).
 */
export class SecuritySettingCatalogCheck
{
    private static readonly SubjectSeparator = '/'
    private static readonly FieldSeparator = '.'

    private static readonly Mapped: ReadonlyMap<Tier1DiagnosticCode, SecuritySettingIssueCode> = new Map([
        [Tier1DiagnosticCode.UnknownAssignedRole, SecuritySettingIssueCode.UnknownRole],
        [Tier1DiagnosticCode.OverrideUnknownRole, SecuritySettingIssueCode.UnknownRole],
        [Tier1DiagnosticCode.UnknownAssignedProfile, SecuritySettingIssueCode.UnknownProfile],
        [Tier1DiagnosticCode.OverrideUnknownProfile, SecuritySettingIssueCode.UnknownProfile],
        [Tier1DiagnosticCode.OverrideUnknownConcept, SecuritySettingIssueCode.UnknownConcept],
        [Tier1DiagnosticCode.OverridePlatformConcept, SecuritySettingIssueCode.UnknownConcept],
        [Tier1DiagnosticCode.OverrideUnknownField, SecuritySettingIssueCode.UnsecuredField],
        [Tier1DiagnosticCode.NonOrganizationDepthOnUnownedConcept, SecuritySettingIssueCode.OrganizationOwnedDepth],
    ])

    private constructor(private readonly config: ISecurityModelConfig, private readonly described: ReadonlySet<string>, private readonly stored: ReadonlySet<string>)
    {
    }

    public static Issues(config: ISecurityModelConfig, catalog: IEnvironmentCatalog, model: TenantSecurityModel): readonly SecuritySettingIssue[]
    {
        const described = new Set<string>(catalog.Description.Definitions.map(definition => definition.Name))
        const check = new SecuritySettingCatalogCheck(config, described, Tier1Catalog.EngineStoredConcepts(catalog))
        const issues: SecuritySettingIssue[] = [...check.External(), ...check.Administrator()]
        for (const diagnostic of Tier1ScopeCompiler.Diagnose(catalog.Security, model, catalog))
        {
            const code = SecuritySettingCatalogCheck.Mapped.get(diagnostic.Code)
            if (code === undefined) continue
            if (code === SecuritySettingIssueCode.UnknownConcept && check.IsExternal(diagnostic.Subject)) continue
            if (code === SecuritySettingIssueCode.OrganizationOwnedDepth && !check.IsOverride(diagnostic.Subject)) continue
            if (code === SecuritySettingIssueCode.UnsecuredField && check.IsExternalField(diagnostic.Subject)) continue
            issues.push(new SecuritySettingIssue(code, diagnostic.Subject))
        }
        return issues
    }

    /**
     * The entries of `config` that `issue` names, from its subject (the one home of the subject formats): UnknownRole →
     * the role's overrides and assignments; UnknownProfile → the profile's overrides and assignments; UnknownConcept →
     * the role overrides on the concept; ExternalConcept → the role and profile overrides on it; OrganizationOwnedDepth →
     * the `role/concept/action` override at a depth other than none or organization; UnsecuredField → the profile
     * overrides on `concept.field`. SystemAdministratorOverride names none (the admin save refuses it; never stored).
     */
    public static EntriesOf(issue: SecuritySettingIssue, config: ISecurityModelConfig): SecuritySettingEntries
    {
        const subject = issue.Subject
        const none: never[] = []
        switch (issue.Code)
        {
            case SecuritySettingIssueCode.UnknownRole:
                return new SecuritySettingEntries(config.roleOverrides.filter(o => o.role === subject), none, config.roleAssignments.filter(a => a.role === subject), none)
            case SecuritySettingIssueCode.UnknownProfile:
                return new SecuritySettingEntries(none, config.profileOverrides.filter(o => o.profile === subject), none, config.profileAssignments.filter(a => a.profile === subject))
            case SecuritySettingIssueCode.UnknownConcept:
                return new SecuritySettingEntries(config.roleOverrides.filter(o => o.concept === subject), none, none, none)
            case SecuritySettingIssueCode.ExternalConcept:
                return new SecuritySettingEntries(config.roleOverrides.filter(o => o.concept === subject), config.profileOverrides.filter(o => o.concept === subject), none, none)
            case SecuritySettingIssueCode.OrganizationOwnedDepth:
                return new SecuritySettingEntries(config.roleOverrides.filter(o => SecuritySettingCatalogCheck.IsDepthOverride(o, subject)), none, none, none)
            case SecuritySettingIssueCode.UnsecuredField:
                return new SecuritySettingEntries(none, config.profileOverrides.filter(o => SecuritySettingCatalogCheck.FieldSubject(o.concept, o.field) === subject), none, none)
            default:
                return new SecuritySettingEntries(none, none, none, none)
        }
    }

    /** A concept the environment describes but does not store: a connector holds it. */
    private IsExternal(concept: string): boolean
    {
        return this.described.has(concept) && !this.stored.has(concept)
    }

    /** A profile-override subject (`concept.field`) on an external concept, already reported as ExternalConcept. */
    private IsExternalField(subject: string): boolean
    {
        return this.config.profileOverrides.some(o => this.IsExternal(o.concept) && SecuritySettingCatalogCheck.FieldSubject(o.concept, o.field) === subject)
    }

    /** True when `subject` (`role/concept/action`) is a role override row (a package default is never refused here). */
    private IsOverride(subject: string): boolean
    {
        return this.config.roleOverrides.some(o => SecuritySettingCatalogCheck.IsDepthOverride(o, subject))
    }

    /** `override` is the `role/concept/action` row of `subject` at a depth an unowned concept refuses. */
    private static IsDepthOverride(override: IRoleOverrideConfig, subject: string): boolean
    {
        return [override.role, override.concept, override.action].join(SecuritySettingCatalogCheck.SubjectSeparator) === subject
            && override.level !== AccessLevel.None && override.level !== AccessLevel.Organization
    }

    /** The `concept.field` subject of a field diagnostic. */
    private static FieldSubject(concept: string, field: string): string
    {
        return concept + SecuritySettingCatalogCheck.FieldSeparator + field
    }

    private External(): SecuritySettingIssue[]
    {
        const concepts = [...this.config.roleOverrides.map(o => o.concept), ...this.config.profileOverrides.map(o => o.concept)]
        return [...new Set(concepts.filter(concept => this.IsExternal(concept)))].map(concept => new SecuritySettingIssue(SecuritySettingIssueCode.ExternalConcept, concept))
    }

    private Administrator(): SecuritySettingIssue[]
    {
        return this.config.roleOverrides.some(o => o.role === BaseRole.SystemAdministrator)
            ? [new SecuritySettingIssue(SecuritySettingIssueCode.SystemAdministratorOverride, BaseRole.SystemAdministrator)]
            : []
    }
}
