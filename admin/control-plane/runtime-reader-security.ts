import { AccessLevel, BaseRole, PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import type { RoleAssignmentDto, SecurityCatalogDto, SecurityModelDto } from '@pragmatic-tech-ai/pragmatic-protocol'

/**
 * The tier-1 security setting the operator-run loops (the control-plane smoke, the Plexus live-loop orchestrator) give a
 * Runtime environment they create without a creator, which is left unseeded and so denies every data read: the bootstrap
 * admin becomes System Administrator, each reader is placed in the root business unit with the Reader role, and Reader
 * reads each given concept organization-wide (the only read depth an unowned concept takes, and valid for an owned one).
 * What the environment's setting already holds (the demo users and their roles) is kept; re-applying is idempotent.
 */
export class RuntimeReaderSecurity
{
    private static readonly RootUnitId = 'root'
    private static readonly ConceptSeparator = '.'

    public static Secured(current: SecurityModelDto | undefined, adminPrincipalId: string, readers: readonly string[], concepts: readonly string[], tenantName: string = RuntimeReaderSecurity.RootUnitId): SecurityModelDto
    {
        const R = RuntimeReaderSecurity
        const base = current ?? R.Empty()
        const businessUnits = base.businessUnits.length > 0 ? base.businessUnits : [{ id: R.RootUnitId, name: tenantName }]
        const root = (businessUnits.find(u => u.parent === undefined) ?? businessUnits[0]!).id
        const placed = [...new Set([adminPrincipalId, ...readers])]
        const users = [...base.users.filter(u => !placed.includes(u.principalId)), ...placed.map(principalId => ({ principalId, businessUnitId: root }))]
        const kept = base.roleAssignments.filter(a => a.role !== BaseRole.SystemAdministrator && a.role !== BaseRole.Reader)
        const assignments: RoleAssignmentDto[] = [
            ...kept,
            R.Assignment(base, BaseRole.SystemAdministrator, [adminPrincipalId]),
            R.Assignment(base, BaseRole.Reader, readers),
        ].filter(a => a.principalIds.length > 0 || a.teamIds.length > 0)
        const overrides = [
            ...base.roleOverrides.filter(o => !(o.role === BaseRole.Reader && o.action === PrivilegeAction.Read)),
            ...concepts.map(concept => ({ role: BaseRole.Reader as string, concept, action: PrivilegeAction.Read as string, level: AccessLevel.Organization as string })),
        ]
        return { ...base, businessUnits, users, roleAssignments: assignments, roleOverrides: overrides }
    }

    /** Maps each short name (`Widget`) or full name to the catalog's concept name; the ones the catalog lacks are reported. */
    public static Resolve(catalog: SecurityCatalogDto, names: readonly string[]): { resolved: string[]; missing: string[] }
    {
        const R = RuntimeReaderSecurity
        const all = catalog.concepts.map(c => c.name)
        const resolved: string[] = []
        const missing: string[] = []
        for (const name of names)
        {
            const hit = all.find(n => n === name || n.endsWith(R.ConceptSeparator + name))
            if (hit === undefined)
            {
                missing.push(name)
            }
            else
            {
                resolved.push(hit)
            }
        }
        return { resolved, missing }
    }

    /** `role` held by `principals` plus whoever the current setting already gives it, with its existing teams. */
    private static Assignment(model: SecurityModelDto, role: string, principals: readonly string[]): RoleAssignmentDto
    {
        const existing = model.roleAssignments.filter(a => a.role === role)
        return {
            role,
            principalIds: [...new Set([...existing.flatMap(a => a.principalIds), ...principals])],
            teamIds: [...new Set(existing.flatMap(a => a.teamIds))],
        }
    }

    private static Empty(): SecurityModelDto
    {
        return { businessUnits: [], users: [], teams: [], roleAssignments: [], profileAssignments: [], roleOverrides: [], profileOverrides: [] }
    }
}
