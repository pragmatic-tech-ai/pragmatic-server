import { SecurityRoleKind, type SecurityCatalogDto, type SecurityModelDto } from '../../../../tenant-types.js'

// A C5 setting and a catalog shaped like the server's: the three base roles,
// the `projects` package's roles, an owned and an organisation-owned concept,
// one secured field with a profile default.
export class SecurityFixtures
{
    public static Catalog(): SecurityCatalogDto
    {
        return {
            roles: [
                { name: 'SystemAdministrator', kind: SecurityRoleKind.Base, defaults: [] },
                { name: 'BasicUser', kind: SecurityRoleKind.Base, defaults: [{ action: 'read', concept: 'hr.Employee', level: 'businessUnit' }] },
                { name: 'Reader', kind: SecurityRoleKind.Base, defaults: [] },
                { name: 'projects.ProjectManager', kind: SecurityRoleKind.Package, package: 'projects', defaults: [{ action: 'read', concept: 'projects.Project', level: 'businessUnitAndChildren' }] },
                { name: 'projects.ProjectMember', kind: SecurityRoleKind.Package, package: 'projects', defaults: [{ action: 'read', concept: 'projects.Project', level: 'user' }] },
            ],
            concepts: [
                { name: 'hr.Department', package: 'hr', owned: false },
                { name: 'hr.Employee', package: 'hr', owned: true },
                { name: 'projects.Project', package: 'projects', owned: true },
            ],
            securedFields: [{ concept: 'hr.Employee', field: 'Salary' }],
            profiles: [{ name: 'hr.Payroll', package: 'hr', defaults: [{ concept: 'hr.Employee', field: 'Salary', read: true, update: false, create: false }] }],
        }
    }

    public static Model(): SecurityModelDto
    {
        return {
            businessUnits: [{ id: 'root', name: 'Contoso' }, { id: 'sales', name: 'Sales', parent: 'root' }],
            users: [{ principalId: 'alice', businessUnitId: 'sales' }],
            teams: [{ id: 'team-a', name: 'Alpha', businessUnitId: 'sales', idpGroups: ['grp-alpha'], manualMembers: ['bob'] }],
            roleAssignments: [{ role: 'projects.ProjectManager', principalIds: ['alice'], teamIds: ['team-a'] }],
            profileAssignments: [{ profile: 'hr.Payroll', principalIds: ['carol'], teamIds: [] }],
            // The second row names a role and concept the catalog lacks: kept untouched (the server prunes on deploy).
            roleOverrides: [
                { role: 'BasicUser', concept: 'hr.Employee', action: 'read', level: 'user' },
                { role: 'legacy.Auditor', concept: 'legacy.Case', action: 'read', level: 'organization' },
            ],
            profileOverrides: [{ profile: 'hr.Payroll', concept: 'hr.Employee', field: 'Salary', read: true, update: true, create: false }],
        }
    }

    public static Empty(): SecurityModelDto
    {
        return { businessUnits: [], users: [], teams: [], roleAssignments: [], profileAssignments: [], roleOverrides: [], profileOverrides: [] }
    }
}
