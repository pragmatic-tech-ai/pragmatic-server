import type { IEnvironmentCatalog, IEnvironmentSecurity } from '@pragmatic-tech-ai/todl/engine'
import type { IFieldProfileEntry, ISecurityPrivilege } from '@pragmatic-tech-ai/todl'
import { AccessLevel, BaseRole } from '@pragmatic-tech-ai/todl-identity'
import { Tier1Catalog } from '@pragmatic-tech-ai/todl-identity-engine'
import { SecurityRoleKind } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { FieldAccessDto, PrivilegeDto, SecuredFieldDto, SecurityCatalogDto, SecurityConceptDto, SecurityProfileDto, SecurityRoleDto } from '@pragmatic-tech-ai/pragmatic-protocol'

/**
 * Reads an environment's catalog into the security vocabulary an admin edits the C5 setting against (contract C5, spec
 * §4-§6): the base roles (always, in enum order) then every package role, the engine-stored concepts (the platform
 * governs these; connector data and the `todl.*` platform concepts are excluded), the secured fields and the field
 * profiles. A role's `defaults` are the package-provided depths (the stored overrides are NOT folded in — the admin
 * edits the setting on top of these); the max depth is kept per (concept, action) exactly as S3's EffectiveRoleTable.
 * `SystemAdministrator` is unrestricted, so its defaults are empty. The engine's `IEnvironmentSecurity` /
 * `ISecurityPrivilege` / `IFieldProfileEntry` are used directly (public `@pragmatic-tech-ai/todl` contracts), so a drift
 * in the engine's shape is a compile error here, not a silent runtime mismatch.
 */
export class SecurityCatalogReader
{
    private static readonly TodlPrefix = 'todl.'
    private static readonly KeySeparator = '\u0000'
    private static readonly MissingPackage = ''

    /** The depth order S3's EffectiveRoleTable uses, lowest to highest (the C1 level strings). */
    private static readonly DepthOrder: readonly string[] =
    [
        AccessLevel.None,
        AccessLevel.User,
        AccessLevel.BusinessUnit,
        AccessLevel.BusinessUnitAndChildren,
        AccessLevel.Organization,
    ]

    private constructor()
    {
    }

    public static Read(catalog: IEnvironmentCatalog): SecurityCatalogDto
    {
        const security = catalog.Security
        return {
            roles: SecurityCatalogReader.Roles(security),
            concepts: SecurityCatalogReader.Concepts(catalog),
            securedFields: SecurityCatalogReader.SecuredFields(security),
            profiles: SecurityCatalogReader.Profiles(security),
        }
    }

    private static Roles(security: IEnvironmentSecurity): SecurityRoleDto[]
    {
        return [...SecurityCatalogReader.BaseRoles(security), ...SecurityCatalogReader.PackageRoles(security)]
    }

    private static BaseRoles(security: IEnvironmentSecurity): SecurityRoleDto[]
    {
        const roles: SecurityRoleDto[] = []
        for (const name of Object.values(BaseRole))
        {
            const defaults = name === BaseRole.SystemAdministrator ? [] : SecurityCatalogReader.BaseDefaults(security, name)
            roles.push({ name, kind: SecurityRoleKind.Base, defaults })
        }
        return roles
    }

    /** The union of every package's contributions to `roleName`, max depth per (concept, action), sorted. */
    private static BaseDefaults(security: IEnvironmentSecurity, roleName: string): PrivilegeDto[]
    {
        const privileges: ISecurityPrivilege[] = []
        for (const pkg of security.Packages.values())
        {
            for (const contribution of pkg.BaseRoleContributions)
            {
                if (contribution.Name === roleName)
                {
                    privileges.push(...contribution.Privileges)
                }
            }
        }
        return SecurityCatalogReader.Defaults(privileges)
    }

    private static PackageRoles(security: IEnvironmentSecurity): SecurityRoleDto[]
    {
        const roles: SecurityRoleDto[] = []
        for (const [model, pkg] of security.Packages)
        {
            for (const role of pkg.Roles)
            {
                roles.push({ name: role.Name, kind: SecurityRoleKind.Package, package: model, defaults: SecurityCatalogReader.Defaults(role.Privileges) })
            }
        }
        return roles.sort((a, b) => SecurityCatalogReader.ByText(a.name, b.name))
    }

    private static Defaults(privileges: readonly ISecurityPrivilege[]): PrivilegeDto[]
    {
        const byKey = new Map<string, PrivilegeDto>()
        for (const privilege of privileges)
        {
            const key = privilege.Concept + SecurityCatalogReader.KeySeparator + privilege.Action
            const existing = byKey.get(key)
            const level = existing === undefined ? privilege.Depth : SecurityCatalogReader.MaxDepth(existing.level, privilege.Depth)
            byKey.set(key, { action: privilege.Action, concept: privilege.Concept, level })
        }
        return [...byKey.values()].sort((a, b) => SecurityCatalogReader.ByConceptThenAction(a, b))
    }

    private static Concepts(catalog: IEnvironmentCatalog): SecurityConceptDto[]
    {
        const owned = catalog.Security.OwnedConcepts()
        const concepts: SecurityConceptDto[] = []
        for (const name of Tier1Catalog.EngineStoredConcepts(catalog))
        {
            if (name.startsWith(SecurityCatalogReader.TodlPrefix))
            {
                continue
            }
            concepts.push({ name, package: catalog.HomeModels.get(name) ?? SecurityCatalogReader.MissingPackage, owned: owned.has(name) })
        }
        return concepts.sort((a, b) => SecurityCatalogReader.ByText(a.name, b.name))
    }

    private static SecuredFields(security: IEnvironmentSecurity): SecuredFieldDto[]
    {
        const byKey = new Map<string, SecuredFieldDto>()
        for (const pkg of security.Packages.values())
        {
            for (const field of pkg.SecuredFields)
            {
                byKey.set(field.Concept + SecurityCatalogReader.KeySeparator + field.Field, { concept: field.Concept, field: field.Field })
            }
        }
        return [...byKey.values()].sort((a, b) => SecurityCatalogReader.ByConceptThenField(a, b))
    }

    private static Profiles(security: IEnvironmentSecurity): SecurityProfileDto[]
    {
        const profiles: SecurityProfileDto[] = []
        for (const [model, pkg] of security.Packages)
        {
            for (const profile of pkg.FieldProfiles)
            {
                profiles.push({ name: profile.Name, package: model, defaults: SecurityCatalogReader.FieldAccess(profile.Fields) })
            }
        }
        return profiles.sort((a, b) => SecurityCatalogReader.ByText(a.name, b.name))
    }

    private static FieldAccess(fields: readonly IFieldProfileEntry[]): FieldAccessDto[]
    {
        return fields
            .map(field => ({ concept: field.Concept, field: field.Field, read: field.Read, update: field.Update, create: field.Create }))
            .sort((a, b) => SecurityCatalogReader.ByConceptThenField(a, b))
    }

    private static MaxDepth(a: string, b: string): string
    {
        return SecurityCatalogReader.DepthOrder.indexOf(b) > SecurityCatalogReader.DepthOrder.indexOf(a) ? b : a
    }

    private static ByConceptThenAction(a: PrivilegeDto, b: PrivilegeDto): number
    {
        return a.concept !== b.concept ? SecurityCatalogReader.ByText(a.concept, b.concept) : SecurityCatalogReader.ByText(a.action, b.action)
    }

    private static ByConceptThenField(a: SecuredFieldDto, b: SecuredFieldDto): number
    {
        return a.concept !== b.concept ? SecurityCatalogReader.ByText(a.concept, b.concept) : SecurityCatalogReader.ByText(a.field, b.field)
    }

    private static ByText(a: string, b: string): number
    {
        return a < b ? -1 : a > b ? 1 : 0
    }
}
