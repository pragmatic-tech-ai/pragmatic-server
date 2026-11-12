import type { IEnvironmentCatalog } from '@pragmatic-tech-ai/todl/engine'
import { AccessLevel, BaseRole } from '@pragmatic-tech-ai/todl-identity'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
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

    /** A concept the environment describes but does not store: a connector holds it. */
    private IsExternal(concept: string): boolean
    {
        return this.described.has(concept) && !this.stored.has(concept)
    }

    /** A profile-override subject (`concept.field`) on an external concept, already reported as ExternalConcept. */
    private IsExternalField(subject: string): boolean
    {
        return this.config.profileOverrides.some(o => this.IsExternal(o.concept) && o.concept + SecuritySettingCatalogCheck.FieldSeparator + o.field === subject)
    }

    /** True when `subject` (`role/concept/action`) is a role override row (a package default is never refused here). */
    private IsOverride(subject: string): boolean
    {
        return this.config.roleOverrides.some(o => [o.role, o.concept, o.action].join(SecuritySettingCatalogCheck.SubjectSeparator) === subject
            && o.level !== AccessLevel.None && o.level !== AccessLevel.Organization)
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
