import { AccessError, Cypher } from '@pragmatic-tech-ai/graph'
import type { AccessErrorCode, AccessScope, CellValue, GraphEngine } from '@pragmatic-tech-ai/graph'
import { SystemNames } from '@pragmatic-tech-ai/todl/engine'
import { AccessContext, AccessLevel, BaseRole, Grant, Principal, PrincipalKind, PrivilegeAction, ResourceAuthorizationPolicy, ResourceKind, ResourceRef, Role, Tenant, TenantKind } from '@pragmatic-tech-ai/todl-identity'
import type { IRoleAssignmentConfig, IRoleOverrideConfig, ISecurityModelConfig, ITeamConfig } from '@pragmatic-tech-ai/todl-identity'
import type { PragmaticServer } from '../../../pragmatic-server.js'
import type { IGraphScope } from '../../engine/access-scope-source.js'
import { EnvironmentFixture } from './environment-fixture.js'
import type { IEnvironmentFixtureOptions, SeedRow } from './environment-fixture.js'

/** What a tier-1 setting differs by from the fixture's base setting. */
export interface ITier1SettingOptions
{
    readonly RoleAssignments?: readonly IRoleAssignmentConfig[]
    readonly RoleOverrides?: readonly IRoleOverrideConfig[]
    readonly Teams?: readonly ITeamConfig[]
    readonly ProfileAssignments?: ISecurityModelConfig['profileAssignments']
    readonly ProfileOverrides?: ISecurityModelConfig['profileOverrides']
}

/**
 * A Runtime environment for the tier-1 tests (security S4 Task 9): packages `hr` (hr.Employee, owned, with a secured
 * Salary, BasicUser contributing BU-depth access, Reader organisation reads, profile Compensation reading Salary),
 * `projects` (owned Project with a secured budget read by profile Staffing, Task, Note, the reified edge Assignment Task ==> Project, role ProjectManager, BasicUser
 * contributing user-depth Project reads and Task access; Note is covered by no role), `crm` (crm.Account, not owned)
 * and `ext` (ext.Customer bound writable to a SQL source, ext.Vendor read-only). Business units: contoso > sales,
 * contoso > marketing. Principals: alice (sales), bob (marketing), carol (sales, nothing assigned), admin (root,
 * System Administrator), pm (sales). Every role that grants Update grants Append and AppendTo at that depth (R26).
 */
export class Tier1Fx
{
    public static readonly AppName = 'suite'
    public static readonly AppVersion = '1.0.0'
    public static readonly Hr = { id: 'hr', version: '1.0.0' }
    public static readonly Projects = { id: 'projects', version: '1.0.0' }
    public static readonly Crm = { id: 'crm', version: '1.0.0' }
    public static readonly Ext = { id: 'ext', version: '1.0.0' }
    public static readonly HrTodl = `namespace hr
{
    concept Employee : todl.system.Owned { name : string?; secured Salary : number?; }
    contribute BasicUser { Employee { read = businessUnit; create = businessUnit; update = businessUnit; append = businessUnit; appendTo = businessUnit; share = user; assign = businessUnit; } }
    contribute Reader { Employee { read = organization; } }
    profile Compensation { Employee.Salary : read; }
}`
    public static readonly ProjectsTodl = `namespace projects
{
    concept Project : todl.system.Owned { name : string?; secured budget : number?; }
    concept Task : todl.system.Owned { name : string?; project : Project?; }
    concept Note : todl.system.Owned { name : string?; }
    concept Assignment { from : Task; to : Project; }
    operator ==> : Assignment (from, to);
    role ProjectManager { Project { read = organization; update = businessUnit; append = businessUnit; appendTo = businessUnit; assign = businessUnit; share = businessUnit; } }
    role TaskEditor { Task { read = organization; update = organization; } Project { read = organization; } }
    role TaskLinker { Task { read = organization; update = organization; append = organization; } Project { read = organization; appendTo = organization; } }
    profile Staffing { Project.budget : read; }
    contribute BasicUser { Project { read = user; } Task { read = user; update = user; append = user; appendTo = user; } }
}`
    public static readonly CrmTodl = 'namespace crm {\n  concept Account { name : string?; }\n  role AccountReader { Account { read = organization; } }\n}\n'
    public static readonly ExtTodl = 'namespace ext {\n  concept Customer { id : string?; name : string?; }\n  concept Vendor { name : string?; }\n  datasource src { kind = sql; connection = "ext-db"; }\n'
        + '  model Ext : ext { connect src; populate Customer key cust_id { name = "nm"; } populate Vendor key vend_id { name = "nm"; read-only; } }\n}\n'

    public static readonly Employee = 'hr.Employee'
    public static readonly Project = 'projects.Project'
    public static readonly Task = 'projects.Task'
    public static readonly Note = 'projects.Note'
    public static readonly Assignment = 'projects.Assignment'
    public static readonly Account = 'crm.Account'
    public static readonly Customer = 'ext.Customer'
    public static readonly ProjectManager = 'projects.ProjectManager'
    public static readonly TaskEditor = 'projects.TaskEditor'
    public static readonly TaskLinker = 'projects.TaskLinker'
    public static readonly AccountReader = 'crm.AccountReader'
    public static readonly Compensation = 'hr.Compensation'
    public static readonly Staffing = 'projects.Staffing'
    public static readonly Salary = 'Salary'
    public static readonly Name = 'name'
    public static readonly ProjectMember = 'project'
    public static readonly From = 'from'
    public static readonly To = 'to'

    public static readonly Contoso = 'contoso'
    public static readonly Sales = 'sales'
    public static readonly Marketing = 'marketing'
    public static readonly Alice = 'alice'
    public static readonly Bob = 'bob'
    public static readonly Carol = 'carol'
    public static readonly Admin = 'admin'
    public static readonly Pm = 'pm'
    public static readonly MarketingTeam = 'mkt-team'

    public static readonly CustomerSource = 'Customer'
    public static readonly CustomerKey = 'cust_id'
    public static readonly NameField = 'nm'
    public static readonly CustomerRow = 'k1'
    public static readonly Acme = 'Acme'

    private static readonly TenantName = 'Environment One'
    private static readonly ContosoName = 'Contoso'
    private static readonly SalesName = 'Sales'
    private static readonly MarketingName = 'Marketing'
    private static readonly MarketingTeamName = 'Marketing team'
    private static readonly SelectPrefix = 'MATCH (n:`'
    private static readonly SelectSuffix = '`) RETURN n.name AS name ORDER BY name'

    /** The base setting: placements, alice and bob BasicUser, admin System Administrator; no overrides. */
    public static Setting(options: ITier1SettingOptions = {}): ISecurityModelConfig
    {
        const fx = Tier1Fx
        return {
            businessUnits: [
                { id: fx.Contoso, name: fx.ContosoName },
                { id: fx.Sales, name: fx.SalesName, parent: fx.Contoso },
                { id: fx.Marketing, name: fx.MarketingName, parent: fx.Contoso },
            ],
            users: [
                { principalId: fx.Alice, businessUnitId: fx.Sales },
                { principalId: fx.Bob, businessUnitId: fx.Marketing },
                { principalId: fx.Carol, businessUnitId: fx.Sales },
                { principalId: fx.Admin, businessUnitId: fx.Contoso },
                { principalId: fx.Pm, businessUnitId: fx.Sales },
            ],
            teams: options.Teams ?? [],
            roleAssignments: options.RoleAssignments ?? [
                { role: BaseRole.BasicUser, principalIds: [fx.Alice, fx.Bob], teamIds: [] },
                { role: BaseRole.SystemAdministrator, principalIds: [fx.Admin], teamIds: [] },
            ],
            profileAssignments: options.ProfileAssignments ?? [],
            roleOverrides: options.RoleOverrides ?? [],
            profileOverrides: options.ProfileOverrides ?? [],
        }
    }

    /** A team in marketing whose one manual member is `member`. */
    public static MarketingTeamOf(member: string): ITeamConfig
    {
        return { id: Tier1Fx.MarketingTeam, name: Tier1Fx.MarketingTeamName, businessUnitId: Tier1Fx.Marketing, idpGroups: [], manualMembers: [member] }
    }

    public static Override(role: string, concept: string, action: PrivilegeAction, level: AccessLevel): IRoleOverrideConfig
    {
        return { role, concept, action, level }
    }

    public static Context(principalId: string): AccessContext
    {
        const tenant = new Tenant(EnvironmentFixture.TenantId, TenantKind.SelfHosted, Tier1Fx.TenantName)
        const principal = new Principal(principalId, EnvironmentFixture.TenantId, PrincipalKind.User, new Map(), [])
        const grants = [new Grant(principalId, Role.Owner, new ResourceRef(ResourceKind.Tenant, EnvironmentFixture.TenantId, []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    /** The four packages live in one app, the Customer source holding one row, the server started with `options`. */
    public static async Run(options: IEnvironmentFixtureOptions, body: (fx: EnvironmentFixture, server: PragmaticServer) => Promise<void>): Promise<void>
    {
        const fx = new EnvironmentFixture()
        try
        {
            for (const [ref, todl] of [[Tier1Fx.Hr, Tier1Fx.HrTodl], [Tier1Fx.Projects, Tier1Fx.ProjectsTodl], [Tier1Fx.Crm, Tier1Fx.CrmTodl], [Tier1Fx.Ext, Tier1Fx.ExtTodl]] as const)
            {
                await fx.Package(ref.id, ref.version, todl)
            }
            fx.Live(Tier1Fx.AppName, Tier1Fx.AppVersion, [Tier1Fx.Hr, Tier1Fx.Projects, Tier1Fx.Crm, Tier1Fx.Ext])
            fx.Source.Adapter.Seed(Tier1Fx.CustomerSource, [{ [Tier1Fx.CustomerKey]: Tier1Fx.CustomerRow, [Tier1Fx.NameField]: Tier1Fx.Acme }])
            const server = await fx.Start(options)
            await body(fx, server)
        }
        finally
        {
            await fx.Dispose()
        }
    }

    /** An owned record of `concept` named `id`, owned by `owner` in `unit` (System transaction). */
    public static Owned(concept: string, id: string, owner: string, unit: string, properties: Readonly<Record<string, CellValue>> = {}): SeedRow
    {
        return { Concept: concept, Id: id, Properties: { [Tier1Fx.Name]: id, [SystemNames.Owner]: owner, [SystemNames.OwningBusinessUnit]: unit, ...properties } }
    }

    public static async Scope(server: PragmaticServer, principalId: string): Promise<IGraphScope>
    {
        return (await server.EnvironmentScopes()).ScopeFor(Tier1Fx.Context(principalId))
    }

    /** The first column of `query` under `scope`. */
    public static async Column(server: PragmaticServer, scope: AccessScope, query: string): Promise<unknown[]>
    {
        const result = await new Cypher.CypherEngine(await server.EnvironmentEngine().Engine()).Execute(scope, query)
        return result.Rows.map(row => (row[0] as Cypher.ScalarValue).Value)
    }

    /** The names of `concept`'s records `principalId` reads. */
    public static async Names(server: PragmaticServer, principalId: string, concept: string): Promise<unknown[]>
    {
        return Tier1Fx.Column(server, (await Tier1Fx.Scope(server, principalId)).Scope, Tier1Fx.SelectPrefix + concept + Tier1Fx.SelectSuffix)
    }

    public static async Engine(server: PragmaticServer): Promise<GraphEngine>
    {
        return server.EnvironmentEngine().Engine()
    }

    /** Sets `member` of `id` to `value` in one transaction under `scope`. */
    public static async Update(engine: GraphEngine, scope: AccessScope, id: string, member: string, value: CellValue): Promise<void>
    {
        const transaction = await engine.Begin(scope)
        try
        {
            transaction.SetProperty(id, member, value)
            await transaction.Commit()
        }
        finally
        {
            transaction.dispose()
        }
    }

    /** Links `from` to `to` through `relationship` in one transaction under `scope`. */
    public static async Link(engine: GraphEngine, scope: AccessScope, from: string, relationship: string, to: string): Promise<void>
    {
        const transaction = await engine.Begin(scope)
        try
        {
            transaction.Link(from, relationship, to)
            await transaction.Commit()
        }
        finally
        {
            transaction.dispose()
        }
    }

    public static Denied(code: AccessErrorCode): (error: unknown) => boolean
    {
        return error => error instanceof AccessError && error.Code === code
    }
}
