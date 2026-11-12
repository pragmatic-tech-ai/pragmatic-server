import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccessScope } from '@pragmatic-tech-ai/graph'
import type { CellValue } from '@pragmatic-tech-ai/graph'
import { ShareRight, SystemNames } from '@pragmatic-tech-ai/todl/engine'
import { AppWriteStatus, createMessageConnection, InMemoryMessageSocket, NullLogger, PragmaticClient, ShareStatus, ShareSubjectKind, TeamMemberOrigin, WebSocketMessageReader, WebSocketMessageWriter } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AppDeployResultDto, CypherAppDeployParamsDto, CypherParamValue, SecurityModelDto, ShareResultDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AccessLevel, BaseRole, PresentedSecret, Principal, PrincipalKind, PrivilegeAction, ResourceKind, Role } from '@pragmatic-tech-ai/todl-identity'
import { LocalSourceTokenProvider } from '@pragmatic-tech-ai/todl-identity-local'
import { AdminProxy, WsAdminConnection, WsAdminConnector } from '../../../admin/control-plane/admin-proxy.js'
import { ClientRegistry } from '../../../admin/control-plane/client-registry.js'
import { BundleBuilderAdapter, UserSeederAdapter } from '../../../admin/control-plane/docker-env-port.js'
import type { IDockerEnv } from '../../../admin/control-plane/docker-env-port.js'
import { EnvironmentEndpoints } from '../../../admin/control-plane/environment-endpoints.js'
import { EnvType, Template } from '../../../admin/control-plane/environment-record.js'
import type { IContainerProbe } from '../../../admin/control-plane/environment-record.js'
import { EnvironmentRegistry } from '../../../admin/control-plane/environment-registry.js'
import { DockerEnvironmentRuntime } from '../../../admin/control-plane/environment-runtime.js'
import { EnvironmentRuntimeResolver } from '../../../admin/control-plane/environment-runtime-resolver.js'
import { EnvironmentSecuritySeed } from '../../../admin/control-plane/environment-security-seed.js'
import { EnvironmentService } from '../../../admin/control-plane/environment-service.js'
import { HiveOrchestratorFactory } from '../../../admin/control-plane/hive-orchestrator-factory.js'
import { HiveRegistry } from '../../../admin/control-plane/hive-registry.js'
import { IdpAdminClient } from '../../../admin/control-plane/idp-admin-client.js'
import type { IdpConnection, IIdpService } from '../../../admin/control-plane/idp-service.js'
import { PlatformDirectory } from '../../../admin/control-plane/platform-directory.js'
import { PortAllocator } from '../../../admin/control-plane/port-allocator.js'
import type { IPortProbe } from '../../../admin/control-plane/port-allocator.js'
import { TenantRegistry } from '../../../admin/control-plane/tenant-registry.js'
import { TenantPurposeName } from '../../../environments/seed/bundle.js'
import type { EnvDefinition } from '../../../environments/seed/bundle.js'
import { DockerEnv } from '../../../environments/seed/docker.js'
import type { ILogProcess } from '../../../environments/seed/docker.js'
import { UserSeeder } from '../../../environments/seed/users.js'
import { ServerBootstrap } from '../../bin/server-bootstrap.js'
import { ProvisionedSecretsFactory } from '../../config/provisioned-secrets-factory.js'
import { ServerConfigLoader } from '../../config/server-config-loader.js'
import { TenantProvisioningFactory } from '../../config/tenant-provisioning-factory.js'
import { PragmaticServerHost } from '../../host/pragmatic-server-host.js'
import { NullLogger as ServerNullLogger } from '../../observability/logger.js'
import type { PragmaticServer } from '../../pragmatic-server.js'
import { AdminEnums } from '../../host/admin-enums.js'
import { AdminService } from '../../host/admin-service.js'
import { CallerCredentialAdapterFactory, ConnectionCredentialMode } from '../../host/connectors/caller-credential-adapter-factory.js'
import { ServerConnectionHandler } from '../../host/server-connection-handler.js'
import { EnvironmentFixture } from '../../host/environment/tests/environment-fixture.js'
import type { FixturePackageRef, SeedRow } from '../../host/environment/tests/environment-fixture.js'

/** One package of a capstone environment: its ref and TODL source. */
type CapstonePackage = readonly [FixturePackageRef, string]

/**
 * The platform security capstone (spec 2026-11-11 §9, §5; S4 Task 14): a Runtime environment over the M2.3
 * EnvironmentFixture with identity and the IdP directory sync left on (the local IdP is authoritative, so every
 * principal is a real local account and IdP groups are local groups); the setting is saved and read over the admin
 * wire (AdminService over `PragmaticServer.SecurityAdmin()`, as the host wires it), data is read and written by real
 * PragmaticClients, deploys go through `pragmatic/app/deploy`.
 */
class CapstoneFx
{
    public static readonly App = 'suite'
    public static readonly V1 = '1.0.0'
    public static readonly V2 = '2.0.0'
    private static readonly Password = 'capstone-password-1'
    private static readonly EmailSuffix = '@capstone.test'
    private static readonly ModelFile = 'model.json'
    private static readonly Entry = 'index.html'
    private static readonly Page = '<html></html>'
    private static readonly Base64 = 'base64'
    private static readonly Utf8 = 'utf8'
    private static readonly NoPacks = { Invalidate: async () => undefined, AllowScripts: async () => undefined, DenyScripts: async () => undefined, ListScriptAllowlist: async () => [] }

    private readonly admins: { Connection: WsAdminConnection; Handler: ServerConnectionHandler }[] = []

    private constructor(public readonly Fx: EnvironmentFixture, public readonly Server: PragmaticServer)
    {
    }

    /**
     * Compiles `packages`, makes `live` the `suite` app, seeds `sources` into the fixture's SQL source, starts the server
     * with identity and the directory sync on, registers `accounts` as local accounts and `groups` as local groups.
     */
    public static async Run(options: { Packages: readonly CapstonePackage[]; Live: readonly FixturePackageRef[]; Accounts: readonly string[]; Groups?: Readonly<Record<string, readonly string[]>>; Sources?: Readonly<Record<string, readonly Record<string, string>[]>> },
        body: (cap: CapstoneFx) => Promise<void>): Promise<void>
    {
        const fx = new EnvironmentFixture()
        let cap: CapstoneFx | undefined
        try
        {
            for (const [ref, todl] of options.Packages) await fx.Package(ref.id, ref.version, todl)
            fx.Live(CapstoneFx.App, CapstoneFx.V1, options.Live)
            for (const [source, rows] of Object.entries(options.Sources ?? {})) fx.Source.Adapter.Seed(source, rows)
            const server = await fx.Start({ Identity: true, DirectorySyncOnStart: true })
            await server.EnvironmentEngine().Engine()
            cap = new CapstoneFx(fx, server)
            const pack = await server.Pack()
            for (const id of options.Accounts) await pack.Registrar.Register(server.Tenant(), id + CapstoneFx.EmailSuffix, id, new PresentedSecret(CapstoneFx.Password))
            for (const [group, members] of Object.entries(options.Groups ?? {}))
            {
                await pack.Groups.CreateGroup(server.Tenant(), group, group)
                for (const member of members) await pack.Groups.AddMember(server.Tenant(), group, member)
            }
            await body(cap)
        }
        finally
        {
            cap?.DisposeAdmins()
            await fx.Dispose()
        }
    }

    public static Principal(id: string): Principal
    {
        return new Principal(id, EnvironmentFixture.TenantId, PrincipalKind.User, new Map(), [])
    }

    /** An admin-wire connection as `principalId` (tenant Owner), over the admin service the host builds. */
    public async Admin(principalId: string): Promise<WsAdminConnection>
    {
        const server = this.Server
        const pack = await server.Pack()
        const service = new AdminService(pack.Grants, pack.Audit, await server.TenantConfigStore(), server.Tenant(), async () => undefined, pack.Accounts, pack.Registrar, pack.Tokens, CapstoneFx.NoPacks, await server.SecurityAdmin())
        const runtime = ServerConnectionHandler.RuntimeAttachArgs(server)
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(serverSocket, await server.LanguageService(), await server.Manager(), this.Fx.ContextFor(CapstoneFx.Principal(principalId)),
            runtime.connectors, runtime.cypherQuery, undefined, undefined, undefined, undefined, service, undefined, server.Purpose(), runtime.applications, runtime.data)
        const connection = createMessageConnection(new WebSocketMessageReader(clientSocket), new WebSocketMessageWriter(clientSocket), NullLogger)
        connection.listen()
        const admin = new WsAdminConnection(connection)
        this.admins.push({ Connection: admin, Handler: handler })
        return admin
    }

    /** Saves `model` over the admin wire, then waits for the directory sync the save requested. */
    public async Apply(model: SecurityModelDto, adminId: string): Promise<void>
    {
        await (await this.Admin(adminId)).SetSecurityModel(model)
        await this.Sync()
    }

    /** One directory sync run against the local IdP (after a group or account change). */
    public async Sync(): Promise<void>
    {
        await (await this.Server.DirectorySync()).RunNow()
    }

    public Client(principalId: string): Promise<PragmaticClient>
    {
        return this.Fx.Connect(CapstoneFx.Principal(principalId))
    }

    /** The rows `principalId` reads through `cypher/query`. */
    public async Rows(principalId: string, cypher: string, parameters?: { [k: string]: CypherParamValue }): Promise<unknown[][]>
    {
        return (await (await this.Client(principalId)).CypherQuery(cypher, parameters)).items
    }

    /** The first column `principalId` reads through `cypher/query`. */
    public async Column(principalId: string, cypher: string, parameters?: { [k: string]: CypherParamValue }): Promise<unknown[]>
    {
        return (await this.Rows(principalId, cypher, parameters)).map(row => row[0])
    }

    /** Writes `rows` as engine-stored owned records (System transaction): `[concept, id, owner, unit, properties]`. */
    public Seed(rows: readonly (readonly [string, string, string, string, Readonly<Record<string, CellValue>>?])[]): Promise<bigint>
    {
        return this.Fx.Seed(rows.map(([concept, id, owner, unit, properties]): SeedRow =>
            ({ Concept: concept, Id: id, Properties: { [CapstoneText.Name]: id, [SystemNames.Owner]: owner, [SystemNames.OwningBusinessUnit]: unit, ...(properties ?? {}) } })))
    }

    /** Sets `member` of `id` (System transaction): data written behind the platform, as a populate job would. */
    public async SystemSet(id: string, member: string, value: CellValue): Promise<void>
    {
        const transaction = await (await this.Server.EnvironmentEngine().Engine()).Begin(AccessScope.System)
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

    /** Links `from` to `to` through `member` (System transaction). */
    public async SystemLink(from: string, member: string, to: string): Promise<void>
    {
        const transaction = await (await this.Server.EnvironmentEngine().Engine()).Begin(AccessScope.System)
        try
        {
            transaction.Link(from, member, to)
            await transaction.Commit()
        }
        finally
        {
            transaction.dispose()
        }
    }

    /** Deploys `refs` as `suite@version` through `principalId`'s client (`pragmatic/app/deploy`); asserts it applied. */
    public async Deploy(principalId: string, version: string, refs: readonly FixturePackageRef[]): Promise<AppDeployResultDto>
    {
        return CapstoneFx.DeployThrough(await this.Client(principalId), this.Fx.PackagesDir, version, refs)
    }

    /** Deploys `refs` (compiled under `packagesDir`) as `suite@version` through `client`; asserts it applied. */
    public static async DeployThrough(client: PragmaticClient, packagesDir: string, version: string, refs: readonly FixturePackageRef[]): Promise<AppDeployResultDto>
    {
        const params: CypherAppDeployParamsDto = {
            appName: CapstoneFx.App,
            appVersion: version,
            packages: refs.map(ref => ({ id: ref.id, version: ref.version, modelJson: readFileSync(join(packagesDir, ref.id, ref.version, CapstoneFx.ModelFile), CapstoneFx.Utf8) })),
            uiBundle: [{ path: CapstoneFx.Entry, contentBase64: Buffer.from(CapstoneFx.Page).toString(CapstoneFx.Base64) }],
            manifest: { name: CapstoneFx.App, version, packages: refs.map(ref => ({ id: ref.id, version: ref.version })), ui: { entry: CapstoneFx.Entry, assets: [] } },
        }
        const result = await client.DeployApplication(params)
        assert.equal(result.status, AppWriteStatus.Applied, result.reason)
        return result
    }

    private DisposeAdmins(): void
    {
        for (const { Connection, Handler } of this.admins.splice(0))
        {
            Connection.Dispose()
            Handler.Dispose()
        }
    }
}

class CapstoneText
{
    public static readonly Name = 'name'
    public static readonly Contoso = 'contoso'
    public static readonly ContosoName = 'Contoso'
    public static readonly Sales = 'sales'
    public static readonly Admin = 'admin'
}

/**
 * §9.1 / §9.4: package `hr` — Employee owned (BasicUser reads at BU, writes at User; Reader reads at BU), secured Salary
 * and NationalId, profile Compensation {Salary: read, update}; v2 adds owned Review (BasicUser reads it at User), a
 * secured Bonus and `Bonus: read` in Compensation. Units contoso > sales, contoso > hr. Team HR (unit hr) links the IdP
 * group hr-staff (dana, henry) and has dana as a manual member; BasicUser → sam and team HR; Compensation → team HR.
 * Records: Ellen (sales, sam's), Hank (hr, owned by team HR), Ivy (hr, henry's), all paid over 100000.
 */
class HrFx
{
    public static readonly SaysSalesEmployeesOnlyAndNoSalary = 'Sales employees only, and no Salary'
    public static readonly SaysTheSecuredFieldIsNonexistentTo = 'the secured field is nonexistent to sam inside the filter'
    public static readonly SaysIdenticalToAFilterOnAn = 'identical to a filter on an absent field'
    public static readonly SaysTheSameFilterMatchesForA = 'the same filter matches for a Compensation holder'
    public static readonly SaysDanaHoldsTheManualRowOnly = 'dana holds the manual row only'
    public static readonly SaysHREmployeesWithSalary = 'HR employees with Salary'
    public static readonly SaysDanaIsBothASyncedAnd = 'dana is both a synced and a manual member'
    public static readonly SaysOnlyTheManualRowIsLeft = 'only the manual row is left'
    public static readonly SaysTheManualRowKeepsTheTeam = 'the manual row keeps the team role and profile'
    public static readonly SaysHenryAMemberThroughTheGroup = 'henry, a member through the group only, lost the team role'
    public static readonly SaysADisabledIdentityReadsNothingManual = 'a disabled identity reads nothing, manual team row or not'
    public static readonly SaysTeamHRsCompensationAssignmentNowCovers = 'team HR\'s Compensation assignment now covers Bonus'
    public static readonly SaysBonusIsNonexistentWithoutTheProfile = 'Bonus is nonexistent without the profile'
    public static readonly SaysTheChangeLogShowsTheSame = 'the change log shows the same entry'
    public static readonly Hr1 = { id: 'hr', version: '1.0.0' }
    public static readonly Hr2 = { id: 'hr', version: '2.0.0' }
    public static readonly Hr1Todl = `namespace hr
{
    concept Employee : todl.system.Owned { name : string?; secured Salary : number?; secured NationalId : string?; }
    contribute BasicUser { Employee { read = businessUnit; create = user; update = user; append = user; appendTo = user; } }
    contribute Reader { Employee { read = businessUnit; } }
    profile Compensation { Employee.Salary : read, update; }
}`
    public static readonly Hr2Todl = `namespace hr
{
    concept Employee : todl.system.Owned { name : string?; secured Salary : number?; secured NationalId : string?; secured Bonus : number?; }
    concept Review : todl.system.Owned { name : string?; }
    contribute BasicUser { Employee { read = businessUnit; create = user; update = user; append = user; appendTo = user; } Review { read = user; } }
    contribute Reader { Employee { read = businessUnit; } }
    profile Compensation { Employee.Salary : read, update; Employee.Bonus : read; }
}`
    public static readonly Employee = 'hr.Employee'
    public static readonly Review = 'hr.Review'
    public static readonly Compensation = 'hr.Compensation'
    public static readonly Salary = 'Salary'
    public static readonly Bonus = 'Bonus'
    public static readonly Hr = 'hr'
    public static readonly HrName = 'HR'
    public static readonly SalesName = 'Sales'
    public static readonly HrTeam = 'hr-team'
    public static readonly HrStaff = 'hr-staff'
    public static readonly Sam = 'sam'
    public static readonly Dana = 'dana'
    public static readonly Henry = 'henry'
    public static readonly Ellen = 'Ellen'
    public static readonly Hank = 'Hank'
    public static readonly Ivy = 'Ivy'
    public static readonly EllenSalary = 150000
    public static readonly HankSalary = 120000
    public static readonly IvySalary = 110000
    public static readonly RaisedSalary = 130000
    public static readonly HankBonus = 7000
    public static readonly EllenBonus = 9000
    public static readonly NamesAndSalaries = 'MATCH (e:`hr.Employee`) RETURN e.name AS name, e.Salary AS salary ORDER BY name'
    public static readonly HighSalaries = 'MATCH (e:`hr.Employee`) WHERE e.Salary > 100000 RETURN e.name AS name ORDER BY name'
    public static readonly HighMissing = 'MATCH (e:`hr.Employee`) WHERE e.Missing > 100000 RETURN e.name AS name ORDER BY name'
    public static readonly BonusOf = 'MATCH (e:`hr.Employee`) WHERE e.name = $name RETURN e.Bonus AS bonus'
    public static readonly SalaryOf = 'MATCH (e:`hr.Employee`) WHERE e.name = $name RETURN e.Salary AS salary'
    public static readonly Raise = 'MATCH (e:`hr.Employee`) WHERE e.name = $name SET e.Salary = $salary RETURN e.name AS name'

    public static Setting(): SecurityModelDto
    {
        return {
            businessUnits: [
                { id: CapstoneText.Contoso, name: CapstoneText.ContosoName },
                { id: CapstoneText.Sales, name: HrFx.SalesName, parent: CapstoneText.Contoso },
                { id: HrFx.Hr, name: HrFx.HrName, parent: CapstoneText.Contoso },
            ],
            users: [
                { principalId: CapstoneText.Admin, businessUnitId: CapstoneText.Contoso },
                { principalId: HrFx.Sam, businessUnitId: CapstoneText.Sales },
                { principalId: HrFx.Dana, businessUnitId: HrFx.Hr },
                { principalId: HrFx.Henry, businessUnitId: HrFx.Hr },
            ],
            teams: [{ id: HrFx.HrTeam, name: HrFx.HrName, businessUnitId: HrFx.Hr, idpGroups: [HrFx.HrStaff], manualMembers: [HrFx.Dana] }],
            roleAssignments: [
                { role: BaseRole.BasicUser, principalIds: [HrFx.Sam], teamIds: [HrFx.HrTeam] },
                { role: BaseRole.SystemAdministrator, principalIds: [CapstoneText.Admin], teamIds: [] },
            ],
            profileAssignments: [{ profile: HrFx.Compensation, principalIds: [], teamIds: [HrFx.HrTeam] }],
            roleOverrides: [],
            profileOverrides: [],
        }
    }

    /** hr v1 (and v2, compiled) live as v1, the setting applied, the three employees seeded. */
    public static async Run(body: (cap: CapstoneFx) => Promise<void>): Promise<void>
    {
        await CapstoneFx.Run({
            Packages: [[HrFx.Hr1, HrFx.Hr1Todl], [HrFx.Hr2, HrFx.Hr2Todl]],
            Live: [HrFx.Hr1],
            Accounts: [CapstoneText.Admin, HrFx.Sam, HrFx.Dana, HrFx.Henry],
            Groups: { [HrFx.HrStaff]: [HrFx.Dana, HrFx.Henry] },
        }, async cap =>
        {
            await cap.Apply(HrFx.Setting(), CapstoneText.Admin)
            await cap.Seed([
                [HrFx.Employee, HrFx.Ellen, HrFx.Sam, CapstoneText.Sales, { [HrFx.Salary]: HrFx.EllenSalary }],
                [HrFx.Employee, HrFx.Hank, HrFx.HrTeam, HrFx.Hr, { [HrFx.Salary]: HrFx.HankSalary }],
                [HrFx.Employee, HrFx.Ivy, HrFx.Henry, HrFx.Hr, { [HrFx.Salary]: HrFx.IvySalary }],
            ])
            await body(cap)
        })
    }

    public static Salaries(cap: CapstoneFx, principalId: string): Promise<unknown[][]>
    {
        return cap.Rows(principalId, HrFx.NamesAndSalaries)
    }
}

/**
 * §9.2 / §5: package `projects` — Project and Task owned, Task.project links a Project, the edge concept Assignment
 * (Task ==> Project). ProjectMember reads / writes / shares Project and Task at User; ProjectManager reads them at
 * BU+children and writes at BU. Units contoso > sales, marketing, engineering. ProjectMember → alice (sales), bob
 * (marketing), carol (engineering); ProjectManager → team Managers (unit contoso) linking the IdP group managers
 * (mike, contoso). Records: P0 (mike, contoso), P1 (alice, sales), P2 (bob, marketing), T3 (carol, engineering)
 * linking P1.
 */
class ProjectsFx
{
    public static readonly SaysAliceSeesHerOwnProjectAnd = 'alice sees her own project and bob\'s shared one'
    public static readonly SaysCarolsTaskIsNotReturned = 'carol\'s task is not returned'
    public static readonly SaysNorReachedFromP1 = 'nor reached from P1'
    public static readonly SaysNorCounted = 'nor counted'
    public static readonly SaysTheEdgeIsThere = 'the edge is there'
    public static readonly SaysCarolSeesHerTask = 'carol sees her task'
    public static readonly SaysT3P1YieldsNothingWhileP1 = 'T3 -> P1 yields nothing while P1 is hidden from carol'
    public static readonly SaysOnceCarolCanSeeP1The = 'once carol can see P1 the traversal reaches it'
    public static readonly SaysProjectManagerReadsBUChildrenThrough = 'Project Manager reads BU+children through the Managers team'
    public static readonly SaysTheOverrideNarrowsReadsToThe = 'the override narrows reads to the BU, no redeploy'
    public static readonly SaysASecurityChangingUpgrade = 'a security-changing upgrade'
    public static readonly SaysThatDropsNoOverride = 'that drops no override'
    public static readonly SaysTheStoredOverrideSurvived = 'the stored override survived'
    public static readonly SaysAndStillAppliesUnderV2 = 'and still applies under v2'
    public static readonly SaysTheAssignmentToBobsProjectIs = 'the assignment to bob\'s project is not returned (PR4)'
    public static readonly Projects1 = { id: 'projects', version: '1.0.0' }
    public static readonly Projects2 = { id: 'projects', version: '2.0.0' }
    private static readonly Body = `
    concept Project : todl.system.Owned { name : string?; }
    concept Assignment { from : Task; to : Project; }
    operator ==> : Assignment (from, to);
    role ProjectMember
    {
        Project { read = user; update = user; append = user; appendTo = user; share = user; }
        Task { read = user; update = user; append = user; appendTo = user; share = user; }
    }
    role ProjectManager
    {
        Project { read = businessUnitAndChildren; update = businessUnit; append = businessUnit; appendTo = businessUnit; }
        Task { read = businessUnitAndChildren; update = businessUnit; append = businessUnit; appendTo = businessUnit; }
    }`
    public static readonly Projects1Todl = 'namespace projects\n{\n    concept Task : todl.system.Owned { name : string?; project : Project?; }' + ProjectsFx.Body + '\n}'
    public static readonly Projects2Todl = 'namespace projects\n{\n    concept Task : todl.system.Owned { name : string?; project : Project?; secured estimate : number?; }' + ProjectsFx.Body + '\n}'
    public static readonly Project = 'projects.Project'
    public static readonly Task = 'projects.Task'
    public static readonly Assignment = 'projects.Assignment'
    public static readonly ProjectManager = 'projects.ProjectManager'
    public static readonly ProjectMember = 'projects.ProjectMember'
    public static readonly ProjectLink = 'project'
    public static readonly Estimate = 'estimate'
    public static readonly From = 'from'
    public static readonly To = 'to'
    public static readonly Marketing = 'marketing'
    public static readonly Engineering = 'engineering'
    public static readonly Managers = 'managers'
    public static readonly ManagersName = 'Managers'
    public static readonly Alice = 'alice'
    public static readonly Bob = 'bob'
    public static readonly Carol = 'carol'
    public static readonly Mike = 'mike'
    public static readonly P0 = 'P0'
    public static readonly P1 = 'P1'
    public static readonly P2 = 'P2'
    public static readonly P4 = 'P4'
    public static readonly T3 = 'T3'
    public static readonly T5 = 'T5'
    public static readonly A1 = 'A1'
    public static readonly A2 = 'A2'
    public static readonly Projects = 'MATCH (p:`projects.Project`) RETURN p.name AS name ORDER BY name'
    public static readonly Tasks = 'MATCH (t:`projects.Task`) RETURN t.name AS name ORDER BY name'
    public static readonly IncomingCount = 'MATCH (p:`projects.Project`)<-[]-(t) WHERE p.name = $name RETURN count(t) AS c'
    public static readonly Incoming = 'MATCH (p:`projects.Project`)<-[]-(t) WHERE p.name = $name RETURN t.name AS name'
    public static readonly TaskTargets = 'MATCH (t:`projects.Task`)-[]->(p) RETURN p.name AS name ORDER BY name'
    public static readonly AssignmentTargets = 'MATCH (a:`projects.Assignment`)-[]->(p:`projects.Project`) RETURN p.name AS name ORDER BY name'
    public static readonly AssignmentCount = 'MATCH (a:`projects.Assignment`) RETURN count(a) AS c'

    public static Setting(roleOverrides: SecurityModelDto['roleOverrides'] = []): SecurityModelDto
    {
        return {
            businessUnits: [
                { id: CapstoneText.Contoso, name: CapstoneText.ContosoName },
                { id: CapstoneText.Sales, name: CapstoneText.Sales, parent: CapstoneText.Contoso },
                { id: ProjectsFx.Marketing, name: ProjectsFx.Marketing, parent: CapstoneText.Contoso },
                { id: ProjectsFx.Engineering, name: ProjectsFx.Engineering, parent: CapstoneText.Contoso },
            ],
            users: [
                { principalId: CapstoneText.Admin, businessUnitId: CapstoneText.Contoso },
                { principalId: ProjectsFx.Alice, businessUnitId: CapstoneText.Sales },
                { principalId: ProjectsFx.Bob, businessUnitId: ProjectsFx.Marketing },
                { principalId: ProjectsFx.Carol, businessUnitId: ProjectsFx.Engineering },
                { principalId: ProjectsFx.Mike, businessUnitId: CapstoneText.Contoso },
            ],
            teams: [{ id: ProjectsFx.Managers, name: ProjectsFx.ManagersName, businessUnitId: CapstoneText.Contoso, idpGroups: [ProjectsFx.Managers], manualMembers: [] }],
            roleAssignments: [
                { role: ProjectsFx.ProjectMember, principalIds: [ProjectsFx.Alice, ProjectsFx.Bob, ProjectsFx.Carol], teamIds: [] },
                { role: ProjectsFx.ProjectManager, principalIds: [], teamIds: [ProjectsFx.Managers] },
                { role: BaseRole.SystemAdministrator, principalIds: [CapstoneText.Admin], teamIds: [] },
            ],
            profileAssignments: [],
            roleOverrides,
            profileOverrides: [],
        }
    }

    /** projects v1 live (v2 compiled), the setting applied, P0 / P1 / P2 / T3 seeded and T3 linking P1. */
    public static async Run(body: (cap: CapstoneFx) => Promise<void>): Promise<void>
    {
        await CapstoneFx.Run({
            Packages: [[ProjectsFx.Projects1, ProjectsFx.Projects1Todl], [ProjectsFx.Projects2, ProjectsFx.Projects2Todl]],
            Live: [ProjectsFx.Projects1],
            Accounts: [CapstoneText.Admin, ProjectsFx.Alice, ProjectsFx.Bob, ProjectsFx.Carol, ProjectsFx.Mike],
            Groups: { [ProjectsFx.Managers]: [ProjectsFx.Mike] },
        }, async cap =>
        {
            await cap.Apply(ProjectsFx.Setting(), CapstoneText.Admin)
            await cap.Seed([
                [ProjectsFx.Project, ProjectsFx.P0, ProjectsFx.Mike, CapstoneText.Contoso],
                [ProjectsFx.Project, ProjectsFx.P1, ProjectsFx.Alice, CapstoneText.Sales],
                [ProjectsFx.Project, ProjectsFx.P2, ProjectsFx.Bob, ProjectsFx.Marketing],
                [ProjectsFx.Task, ProjectsFx.T3, ProjectsFx.Carol, ProjectsFx.Engineering],
            ])
            await cap.SystemLink(ProjectsFx.T3, ProjectsFx.ProjectLink, ProjectsFx.P1)
            await body(cap)
        })
    }

    /** `ownerId` shares project `id` with `subject` (read) through `data/share` on the `suite` app. */
    public static async ShareAs(cap: CapstoneFx, ownerId: string, id: string, subject: string): Promise<ShareResultDto>
    {
        const client = await cap.Client(ownerId)
        await client.OpenApplication(CapstoneFx.App)
        return client.ShareRecord({ concept: ProjectsFx.Project, id, subject: { kind: ShareSubjectKind.Principal, id: subject }, rights: [ShareRight.Read] })
    }
}

/**
 * §9.3: package `sales` — Account bound to the `crm` connector in caller's-identity mode (`credentials = caller`,
 * `tokenResource`), PriceList bound to the `prices` connector with dedicated credentials; both are SQL over the
 * fixture's MemorySourceAdapter. The setting places alice, bob and nobody in sales and assigns no role at all.
 */
class SalesFx
{
    public static readonly SaysAPrincipalWithNoRoleReads = 'a principal with no role reads the dedicated-credential price list'
    public static readonly SaysTheLocalIdPIssuesThePer = 'the local IdP issues the per-user source tokens'
    public static readonly SaysEachCallersReadReachedTheSource = 'each caller\'s read reached the source on a connection opened with that caller\'s own token'
    public static readonly Sales = { id: 'sales', version: '1.0.0' }
    public static readonly Resource = 'api://crm'
    public static readonly SalesTodl = 'namespace sales\n{\n'
        + '    concept Account { name : string?; }\n'
        + '    concept PriceList { name : string?; }\n'
        + '    datasource crm { kind = sql; connection = "crm-db"; credentials = caller; tokenResource = "' + SalesFx.Resource + '"; }\n'
        + '    datasource prices { kind = sql; connection = "prices-db"; }\n'
        + '    model Crm : sales { connect crm; populate Account key acct_id { name = "nm"; } }\n'
        + '    model Prices : sales { connect prices; populate PriceList key price_id { name = "nm"; } }\n'
        + '}'
    public static readonly AccountSource = 'Account'
    public static readonly PriceListSource = 'PriceList'
    public static readonly AccountKey = 'acct_id'
    public static readonly PriceKey = 'price_id'
    public static readonly NameField = 'nm'
    public static readonly Fabrikam = 'Fabrikam'
    public static readonly A1 = 'a1'
    public static readonly Pr1 = 'p1'
    public static readonly Pr2 = 'p2'
    public static readonly NoSecret = ''
    public static readonly Standard = 'Standard'
    public static readonly Premium = 'Premium'
    public static readonly Alice = 'alice'
    public static readonly Bob = 'bob'
    public static readonly Nobody = 'nobody'
    public static readonly Accounts = 'MATCH (a:`sales.Account`) RETURN a.name AS name ORDER BY name'
    public static readonly PriceLists = 'MATCH (p:`sales.PriceList`) RETURN p.name AS name ORDER BY name'

    public static Setting(): SecurityModelDto
    {
        return {
            businessUnits: [{ id: CapstoneText.Contoso, name: CapstoneText.ContosoName }, { id: CapstoneText.Sales, name: CapstoneText.Sales, parent: CapstoneText.Contoso }],
            users: [SalesFx.Alice, SalesFx.Bob, SalesFx.Nobody].map(principalId => ({ principalId, businessUnitId: CapstoneText.Sales })).concat([{ principalId: CapstoneText.Admin, businessUnitId: CapstoneText.Contoso }]),
            teams: [],
            roleAssignments: [{ role: BaseRole.SystemAdministrator, principalIds: [CapstoneText.Admin], teamIds: [] }],
            profileAssignments: [],
            roleOverrides: [],
            profileOverrides: [],
        }
    }

    public static async Run(body: (cap: CapstoneFx) => Promise<void>): Promise<void>
    {
        await CapstoneFx.Run({
            Packages: [[SalesFx.Sales, SalesFx.SalesTodl]],
            Live: [SalesFx.Sales],
            Accounts: [CapstoneText.Admin, SalesFx.Alice, SalesFx.Bob, SalesFx.Nobody],
            Sources: {
                [SalesFx.AccountSource]: [{ [SalesFx.AccountKey]: SalesFx.A1, [SalesFx.NameField]: SalesFx.Fabrikam }],
                [SalesFx.PriceListSource]: [{ [SalesFx.PriceKey]: SalesFx.Pr1, [SalesFx.NameField]: SalesFx.Standard }, { [SalesFx.PriceKey]: SalesFx.Pr2, [SalesFx.NameField]: SalesFx.Premium }],
            },
        }, async cap =>
        {
            await cap.Apply(SalesFx.Setting(), CapstoneText.Admin)
            await body(cap)
        })
    }
}

/**
 * The Docker seam served in process: `Up` starts a PragmaticServerHost over the generated bundle with the environment
 * variables `DockerEnv.RunArgs` gives the container (the bundle's data dir standing in for the seeded volume). §9.5 uses
 * it with no hive and a creator who is the bundle's bootstrap local admin, so it covers neither the federated nor the
 * unfederated hive branch of the seed; the control-plane test `a hive-bound runtime create seeds the creator only when
 * federated` does.
 */
class InProcessDocker implements IDockerEnv
{
    private static readonly Utf8 = 'utf8'
    private static readonly NoText = ''

    private host: PragmaticServerHost | undefined

    public async EnsureImage(): Promise<boolean>
    {
        return true
    }

    public async Up(def: EnvDefinition, bundleDir: string): Promise<void>
    {
        const read = (path: string): string => readFileSync(path, InProcessDocker.Utf8)
        const config = ServerConfigLoader.Load({
            [DockerEnv.EnvBaseDir]: join(bundleDir, DockerEnv.DataSubdir),
            [DockerEnv.EnvTenantsFile]: join(bundleDir, DockerEnv.TenantsFile),
            [DockerEnv.EnvMasterKeyFile]: join(bundleDir, DockerEnv.MasterKeyFile),
            [DockerEnv.EnvSecretsFile]: join(bundleDir, DockerEnv.SecretsFile),
            [DockerEnv.EnvPort]: String(def.hostPort),
            [DockerEnv.EnvDeploymentMode]: DockerEnv.DeploymentModeLocal,
            ...(def.purpose === TenantPurposeName.Runtime ? { [DockerEnv.EnvAllowedOrigins]: DockerEnv.LocalhostOriginPrefix + String(def.hostPort) } : {}),
        }, read)
        const logger = new ServerNullLogger()
        const audit = ServerBootstrap.AuditSink(config, logger)
        const options = ServerBootstrap.ComposeOptions(config, TenantProvisioningFactory.Build(config, read).provisioning, undefined, ProvisionedSecretsFactory.Build(config, read), logger,
            undefined, audit, ServerBootstrap.RateLimit(config, audit, undefined, logger))
        this.host = await PragmaticServerHost.StartAsync(options)
    }

    public async Down(): Promise<void>
    {
        await this.host?.DisposeAsync()
        this.host = undefined
    }

    public async Logs(): Promise<string>
    {
        return InProcessDocker.NoText
    }

    public LogStream(): ILogProcess
    {
        return { OnData: () => undefined, OnClose: () => undefined, Kill: () => undefined }
    }

    /** `Up` returns once the host listens. */
    public async WaitHealthy(): Promise<void>
    {
    }

    public async Running(): Promise<boolean>
    {
        return this.host !== undefined
    }

    public async RemoveVolume(): Promise<void>
    {
    }

    public BuildCommand(): string
    {
        return InProcessDocker.NoText
    }
}

/** The host port is chosen free up front; the allocator's and the registry's probes agree. */
class FreeProbe implements IPortProbe, IContainerProbe
{
    public async Free(): Promise<boolean>
    {
        return true
    }

    public async Running(): Promise<boolean>
    {
        return true
    }
}

/** No hive, so no federation: the control plane never asks for an IdP. */
class NoIdp implements IIdpService
{
    private static readonly Unexpected = 'an unbound environment needs no IdP'

    public EnsureForTenant(): Promise<IdpConnection>
    {
        return Promise.reject(new Error(NoIdp.Unexpected))
    }

    public async ConnectForTenant(): Promise<IdpConnection | undefined>
    {
        return undefined
    }

    public async TeardownForTenant(): Promise<void>
    {
    }
}

/**
 * §9.5: the control plane (EnvironmentService over the Docker runtime seam served in process, the real AdminProxy over
 * the host's WebSocket) creates Runtime environment `dev-ana` with its bootstrap administrator as the creator. The
 * creator then works it through the tenant-admin calls: test user tess in the local IdP, units A and B, BasicUser for
 * tess; and deploys `hr` (Employee owned; BasicUser reads at BU, creates at User).
 */
class DevEnvFx
{
    public static readonly SaysTheCreateSeededTheCreatorAs = 'the create seeded the creator as System Administrator'
    public static readonly SaysTheCreatorReadsEveryRow = 'the creator reads every row'
    public static readonly SaysBasicUserReadsAtBUDepthUnit = 'BasicUser reads at BU depth: unit A\'s records, its peer\'s included, not unit B\'s'
    public static readonly Name = 'dev-ana'
    public static readonly Creator = 'admin'
    public static readonly Tess = 'tess'
    public static readonly UserPassword = 'test-user-password-1'
    public static readonly A = 'a'
    public static readonly B = 'b'
    public static readonly Hr = { id: 'hr', version: '1.0.0' }
    public static readonly HrTodl = `namespace hr
{
    concept Employee : todl.system.Owned { name : string?; }
    contribute BasicUser { Employee { read = businessUnit; create = user; update = user; append = user; appendTo = user; } }
}`
    public static readonly Root1 = 'root-1'
    public static readonly Root2 = 'root-2'
    public static readonly Own = 'tess-1'
    public static readonly Ulla = 'ulla'
    public static readonly Vic = 'vic'
    public static readonly PeerSuffix = '-1'
    public static readonly EmailDomain = '@dev-ana.test'
    public static readonly Prefix = 'ps-capstone-cp-'
    public static readonly CoarseRole = AdminEnums.NameOfRole(Role.Editor)
    public static readonly TenantKind = AdminEnums.NameOfResourceKind(ResourceKind.Tenant)
    private static readonly Create = 'CREATE (e:`hr.Employee`) SET e.name = $name RETURN e.name AS name'
    private static readonly Employees = 'MATCH (e:`hr.Employee`) RETURN e.name AS name ORDER BY name'
    private static readonly Loopback = '127.0.0.1'
    private static readonly ErrorEvent = 'error'
    private static readonly HttpPrefix = 'http://localhost:'
    private static readonly WsPrefix = 'ws://localhost:'
    private static readonly EnvironmentQuery = '/?environment='
    private static readonly EmailPrefix = 'admin@'
    private static readonly EmailSuffix = '.test'
    private static readonly RegistryFiles = ['envs.json', 'clients.json', 'tenants.json', 'hives.json'] as const

    public static FreePort(): Promise<number>
    {
        return new Promise<number>((resolve, reject) =>
        {
            const probe = createServer()
            probe.on(DevEnvFx.ErrorEvent, reject)
            probe.listen(0, DevEnvFx.Loopback, () =>
            {
                const port = (probe.address() as AddressInfo).port
                probe.close(() => resolve(port))
            })
        })
    }

    /** The control plane over the temp `root` and the in-process Docker seam; environments live under `<root>/<name>`. */
    public static async Service(root: string, docker: InProcessDocker, port: number): Promise<EnvironmentService>
    {
        const [envs, clients, tenants, hives] = DevEnvFx.RegistryFiles.map(file => join(root, file))
        const probe = new FreeProbe()
        const registry = new EnvironmentRegistry(envs, probe)
        await registry.Load()
        const directory = new PlatformDirectory(new ClientRegistry(clients), new TenantRegistry(tenants), new HiveRegistry(hives), registry)
        await directory.Load()
        const runtime = new DockerEnvironmentRuntime(docker, new BundleBuilderAdapter())
        return new EnvironmentService(registry, new PortAllocator(port, probe), new EnvironmentRuntimeResolver(runtime, runtime, directory, new HiveOrchestratorFactory()),
            new UserSeederAdapter(), root, new AdminProxy(new WsAdminConnector()), directory, new NoIdp(), connection => new IdpAdminClient(connection))
    }

    /** A data client of the environment signed in as `email` (the `/auth/login` bearer route). */
    public static async Client(port: number, email: string, password: string): Promise<PragmaticClient>
    {
        const token = await new UserSeeder().Login(DevEnvFx.HttpPrefix + String(port), DevEnvFx.Name, email, password)
        return PragmaticClient.ConnectAsync(DevEnvFx.WsPrefix + String(port) + DevEnvFx.EnvironmentQuery + DevEnvFx.Name, { bearerToken: token })
    }

    public static EmailOf(principalId: string): string
    {
        return principalId + DevEnvFx.EmailDomain
    }

    public static CreatorEmail(): string
    {
        return DevEnvFx.EmailPrefix + DevEnvFx.Name + DevEnvFx.EmailSuffix
    }

    /** The seed plus units A and B under the root and tess in A with BasicUser. */
    public static Setting(): SecurityModelDto
    {
        const seed = EnvironmentSecuritySeed.For(DevEnvFx.Name, DevEnvFx.Creator)
        const root = EnvironmentSecuritySeed.RootBusinessUnitId
        return {
            ...seed,
            businessUnits: [...seed.businessUnits, { id: DevEnvFx.A, name: DevEnvFx.A, parent: root }, { id: DevEnvFx.B, name: DevEnvFx.B, parent: root }],
            users: [...seed.users, { principalId: DevEnvFx.Tess, businessUnitId: DevEnvFx.A }, { principalId: DevEnvFx.Ulla, businessUnitId: DevEnvFx.A }, { principalId: DevEnvFx.Vic, businessUnitId: DevEnvFx.B }],
            roleAssignments: [...seed.roleAssignments, { role: BaseRole.BasicUser, principalIds: [DevEnvFx.Tess, DevEnvFx.Ulla, DevEnvFx.Vic], teamIds: [] }],
        }
    }

    public static async Insert(client: PragmaticClient, name: string): Promise<void>
    {
        const created = await client.CypherExecute(DevEnvFx.Create, { name })
        assert.equal(created.status, AppWriteStatus.Applied, created.reason)
    }

    public static async Names(client: PragmaticClient): Promise<unknown[]>
    {
        return (await client.CypherQuery(DevEnvFx.Employees)).items.map(row => row[0])
    }
}

describe('platform security capstone (spec §9, S4 Task 14)', () =>
{
    describe('§9.1 HR app: BU visibility, secured salary, manual team member', () =>
    {
        test('sales manager sees sales employees without salary', async () =>
        {
            await HrFx.Run(async cap =>
            {
                assert.deepEqual(await HrFx.Salaries(cap, HrFx.Sam), [[HrFx.Ellen, null]], HrFx.SaysSalesEmployeesOnlyAndNoSalary)
            })
        })

        test('salary filter returns nothing for a caller without the profile', async () =>
        {
            await HrFx.Run(async cap =>
            {
                const filtered = await cap.Rows(HrFx.Sam, HrFx.HighSalaries)
                assert.deepEqual(filtered, [], HrFx.SaysTheSecuredFieldIsNonexistentTo)
                assert.deepEqual(filtered, await cap.Rows(HrFx.Sam, HrFx.HighMissing), HrFx.SaysIdenticalToAFilterOnAn)
                assert.deepEqual(await cap.Column(HrFx.Dana, HrFx.HighSalaries), [HrFx.Hank, HrFx.Ivy], HrFx.SaysTheSameFilterMatchesForA)
            })
        })

        test('manual team member reads and updates salary', async () =>
        {
            await HrFx.Run(async cap =>
            {
                // dana is left with the manual row only: the read and the update rest on it alone
                await (await cap.Server.Pack()).Groups.RemoveMember(cap.Server.Tenant(), HrFx.HrStaff, HrFx.Dana)
                await cap.Sync()
                assert.deepEqual((await (await cap.Admin(CapstoneText.Admin)).ListTeamMembers(HrFx.HrTeam)).filter(row => row.principalId === HrFx.Dana).map(row => row.origin), [TeamMemberOrigin.Manual], HrFx.SaysDanaHoldsTheManualRowOnly)
                assert.deepEqual(await HrFx.Salaries(cap, HrFx.Dana), [[HrFx.Hank, HrFx.HankSalary], [HrFx.Ivy, HrFx.IvySalary]], HrFx.SaysHREmployeesWithSalary)
                const raised = await (await cap.Client(HrFx.Dana)).CypherExecute(HrFx.Raise, { name: HrFx.Hank, salary: HrFx.RaisedSalary })
                assert.equal(raised.status, AppWriteStatus.Applied, raised.reason)
                assert.deepEqual(await cap.Column(HrFx.Dana, HrFx.SalaryOf, { name: HrFx.Hank }), [HrFx.RaisedSalary])
            })
        })

        test('manual member keeps access after leaving the IdP group', async () =>
        {
            await HrFx.Run(async cap =>
            {
                const admin = await cap.Admin(CapstoneText.Admin)
                const pack = await cap.Server.Pack()
                assert.deepEqual((await admin.ListTeamMembers(HrFx.HrTeam)).filter(row => row.principalId === HrFx.Dana).map(row => row.origin).sort(), [TeamMemberOrigin.Manual, TeamMemberOrigin.Synced], HrFx.SaysDanaIsBothASyncedAnd)
                for (const member of [HrFx.Dana, HrFx.Henry]) await pack.Groups.RemoveMember(cap.Server.Tenant(), HrFx.HrStaff, member)
                await cap.Sync()
                assert.deepEqual((await admin.ListTeamMembers(HrFx.HrTeam)).map(row => [row.principalId, row.origin]), [[HrFx.Dana, TeamMemberOrigin.Manual]], HrFx.SaysOnlyTheManualRowIsLeft)
                assert.deepEqual(await HrFx.Salaries(cap, HrFx.Dana), [[HrFx.Hank, HrFx.HankSalary], [HrFx.Ivy, HrFx.IvySalary]], HrFx.SaysTheManualRowKeepsTheTeam)
                assert.deepEqual(await HrFx.Salaries(cap, HrFx.Henry), [], HrFx.SaysHenryAMemberThroughTheGroup)
            })
        })

        test('disabled identity has no access', async () =>
        {
            await HrFx.Run(async cap =>
            {
                assert.notDeepEqual(await HrFx.Salaries(cap, HrFx.Dana), [])
                await (await cap.Server.Pack()).Accounts.Disable(cap.Server.Tenant(), HrFx.Dana)
                await cap.Sync()
                assert.deepEqual(await HrFx.Salaries(cap, HrFx.Dana), [], HrFx.SaysADisabledIdentityReadsNothingManual)
            })
        })
    })

    describe('§9.2 projects app: depth, sharing, hidden edges', () =>
    {
        test('shared project is visible', async () =>
        {
            await ProjectsFx.Run(async cap =>
            {
                assert.deepEqual(await cap.Column(ProjectsFx.Alice, ProjectsFx.Projects), [ProjectsFx.P1])
                const shared = await ProjectsFx.ShareAs(cap, ProjectsFx.Bob, ProjectsFx.P2, ProjectsFx.Alice)
                assert.equal(shared.status, ShareStatus.Applied, shared.reason)
                assert.deepEqual(await cap.Column(ProjectsFx.Alice, ProjectsFx.Projects), [ProjectsFx.P1, ProjectsFx.P2], ProjectsFx.SaysAliceSeesHerOwnProjectAnd)
            })
        })

        test('hidden task is neither returned nor counted through an edge', async () =>
        {
            await ProjectsFx.Run(async cap =>
            {
                assert.deepEqual(await cap.Column(ProjectsFx.Alice, ProjectsFx.Tasks), [], ProjectsFx.SaysCarolsTaskIsNotReturned)
                assert.deepEqual(await cap.Column(ProjectsFx.Alice, ProjectsFx.Incoming, { name: ProjectsFx.P1 }), [], ProjectsFx.SaysNorReachedFromP1)
                assert.deepEqual((await cap.Column(ProjectsFx.Alice, ProjectsFx.IncomingCount, { name: ProjectsFx.P1 })).map(Number), [0], ProjectsFx.SaysNorCounted)
                assert.deepEqual((await cap.Column(CapstoneText.Admin, ProjectsFx.IncomingCount, { name: ProjectsFx.P1 })).map(Number), [1], ProjectsFx.SaysTheEdgeIsThere)
            })
        })

        test('traversal to an invisible project yields nothing for its task owner', async () =>
        {
            await ProjectsFx.Run(async cap =>
            {
                assert.deepEqual(await cap.Column(ProjectsFx.Carol, ProjectsFx.Tasks), [ProjectsFx.T3], ProjectsFx.SaysCarolSeesHerTask)
                assert.deepEqual(await cap.Column(ProjectsFx.Carol, ProjectsFx.TaskTargets), [], ProjectsFx.SaysT3P1YieldsNothingWhileP1)
                const shared = await ProjectsFx.ShareAs(cap, ProjectsFx.Alice, ProjectsFx.P1, ProjectsFx.Carol)
                assert.equal(shared.status, ShareStatus.Applied, shared.reason)
                assert.deepEqual(await cap.Column(ProjectsFx.Carol, ProjectsFx.TaskTargets), [ProjectsFx.P1], ProjectsFx.SaysOnceCarolCanSeeP1The)
            })
        })

        test('role override survives an upgrade', async () =>
        {
            await ProjectsFx.Run(async cap =>
            {
                assert.deepEqual(await cap.Column(ProjectsFx.Mike, ProjectsFx.Projects), [ProjectsFx.P0, ProjectsFx.P1, ProjectsFx.P2], ProjectsFx.SaysProjectManagerReadsBUChildrenThrough)
                const override = { role: ProjectsFx.ProjectManager, concept: ProjectsFx.Project, action: PrivilegeAction.Read, level: AccessLevel.BusinessUnit }
                await cap.Apply(ProjectsFx.Setting([override]), CapstoneText.Admin)
                assert.deepEqual(await cap.Column(ProjectsFx.Mike, ProjectsFx.Projects), [ProjectsFx.P0], ProjectsFx.SaysTheOverrideNarrowsReadsToThe)
                const upgraded = await cap.Deploy(CapstoneText.Admin, CapstoneFx.V2, [ProjectsFx.Projects2])
                assert.deepEqual(upgraded.securityChanges?.securedFieldsAdded, [{ concept: ProjectsFx.Task, field: ProjectsFx.Estimate }], ProjectsFx.SaysASecurityChangingUpgrade)
                assert.deepEqual(upgraded.securityChanges?.roleOverridesDropped, [], ProjectsFx.SaysThatDropsNoOverride)
                assert.deepEqual((await (await cap.Admin(CapstoneText.Admin)).GetSecurityModel())?.roleOverrides, [override], ProjectsFx.SaysTheStoredOverrideSurvived)
                assert.deepEqual(await cap.Column(ProjectsFx.Mike, ProjectsFx.Projects), [ProjectsFx.P0], ProjectsFx.SaysAndStillAppliesUnderV2)
            })
        })
    })

    describe('§5 edges', () =>
    {
        test('an assignment to a hidden project does not exist', async () =>
        {
            await ProjectsFx.Run(async cap =>
            {
                await cap.Seed([
                    [ProjectsFx.Project, ProjectsFx.P4, ProjectsFx.Bob, ProjectsFx.Marketing],
                    [ProjectsFx.Task, ProjectsFx.T5, ProjectsFx.Alice, CapstoneText.Sales],
                ])
                await cap.Fx.Seed([{ Concept: ProjectsFx.Assignment, Id: ProjectsFx.A1 }, { Concept: ProjectsFx.Assignment, Id: ProjectsFx.A2 }])
                for (const [edge, project] of [[ProjectsFx.A1, ProjectsFx.P1], [ProjectsFx.A2, ProjectsFx.P4]] as const)
                {
                    await cap.SystemLink(edge, ProjectsFx.From, ProjectsFx.T5)
                    await cap.SystemLink(edge, ProjectsFx.To, project)
                }
                assert.deepEqual(await cap.Column(ProjectsFx.Alice, ProjectsFx.AssignmentTargets), [ProjectsFx.P1], ProjectsFx.SaysTheAssignmentToBobsProjectIs)
                assert.deepEqual((await cap.Column(ProjectsFx.Alice, ProjectsFx.AssignmentCount)).map(Number), [1], ProjectsFx.SaysNorCounted)
                assert.deepEqual((await cap.Column(CapstoneText.Admin, ProjectsFx.AssignmentCount)).map(Number), [2])
            })
        })
    })

    describe('§9.3 CRM-backed app: connectors outside the model', () =>
    {
        test('connector rows ignore roles', async () =>
        {
            await SalesFx.Run(async cap =>
            {
                assert.deepEqual(await cap.Column(SalesFx.Nobody, SalesFx.PriceLists), [SalesFx.Premium, SalesFx.Standard], SalesFx.SaysAPrincipalWithNoRoleReads)
            })
        })

        test('caller\'s-identity connector reads as each caller', async () =>
        {
            await SalesFx.Run(async cap =>
            {
                const [alice, bob] = await Promise.all([cap.Column(SalesFx.Alice, SalesFx.Accounts), cap.Column(SalesFx.Bob, SalesFx.Accounts)])
                assert.deepEqual(alice, [SalesFx.Fabrikam])
                assert.deepEqual(bob, [SalesFx.Fabrikam])
                const tokens = (await cap.Server.Pack()).SourceTokens
                assert.ok(tokens instanceof LocalSourceTokenProvider, SalesFx.SaysTheLocalIdPIssuesThePer)
                const opened = cap.Fx.Source.Opened.filter(connection => connection.Config[CallerCredentialAdapterFactory.CredentialsKey] === ConnectionCredentialMode.Caller)
                const subjects = await Promise.all(opened.map(connection => tokens.Verify(EnvironmentFixture.TenantId, connection.Secret ?? SalesFx.NoSecret, SalesFx.Resource)))
                assert.deepEqual(subjects.sort(), [SalesFx.Alice, SalesFx.Bob], SalesFx.SaysEachCallersReadReachedTheSource)
            })
        })
    })

    describe('§9.4 package upgrade adds an owned concept and a secured field, users live', () =>
    {
        test('upgrade widens the existing profile assignment', async () =>
        {
            await HrFx.Run(async cap =>
            {
                await cap.Deploy(CapstoneText.Admin, CapstoneFx.V2, [HrFx.Hr2])
                await cap.SystemSet(HrFx.Hank, HrFx.Bonus, HrFx.HankBonus)
                await cap.SystemSet(HrFx.Ellen, HrFx.Bonus, HrFx.EllenBonus)
                assert.deepEqual(await cap.Column(HrFx.Dana, HrFx.BonusOf, { name: HrFx.Hank }), [HrFx.HankBonus], HrFx.SaysTeamHRsCompensationAssignmentNowCovers)
                assert.deepEqual(await cap.Column(HrFx.Sam, HrFx.BonusOf, { name: HrFx.Ellen }), [null], HrFx.SaysBonusIsNonexistentWithoutTheProfile)
            })
        })

        test('deploy result lists the changes', async () =>
        {
            await HrFx.Run(async cap =>
            {
                const changes = (await cap.Deploy(CapstoneText.Admin, CapstoneFx.V2, [HrFx.Hr2])).securityChanges
                assert.ok(changes !== undefined)
                assert.equal(changes.delivery, CapstoneFx.App)
                assert.equal(changes.version, CapstoneFx.V2)
                assert.deepEqual(changes.securedFieldsAdded, [{ concept: HrFx.Employee, field: HrFx.Bonus }])
                assert.deepEqual(changes.securedFieldsRemoved, [])
                assert.deepEqual(changes.profileDefaults, [{
                    profile: HrFx.Compensation, concept: HrFx.Employee, field: HrFx.Bonus,
                    before: null, after: { concept: HrFx.Employee, field: HrFx.Bonus, read: true, update: false, create: false },
                }])
                assert.deepEqual(changes.roleDefaults, [{ role: BaseRole.BasicUser, concept: HrFx.Review, action: PrivilegeAction.Read, before: AccessLevel.None, after: AccessLevel.User }])
                assert.deepEqual([changes.roleOverridesDropped, changes.profileOverridesDropped, changes.rolesRemoved, changes.profilesRemoved], [[], [], [], []])
                assert.deepEqual(await (await cap.Admin(CapstoneText.Admin)).ListSecurityChanges(), [changes], HrFx.SaysTheChangeLogShowsTheSame)
            })
        })
    })

    describe('§9.5 developer\'s dev environment', () =>
    {
        test('new environment\'s creator administers it', async () =>
        {
            const root = mkdtempSync(join(tmpdir(), DevEnvFx.Prefix))
            const docker = new InProcessDocker()
            const clients: PragmaticClient[] = []
            try
            {
                const port = await DevEnvFx.FreePort()
                const service = await DevEnvFx.Service(root, docker, port)
                const record = await service.Create(DevEnvFx.Name, Template.DevBlank, EnvType.Runtime, port, undefined, DevEnvFx.Creator)
                assert.deepEqual(await service.AdminGetSecurityModel(DevEnvFx.Name), EnvironmentSecuritySeed.For(DevEnvFx.Name, DevEnvFx.Creator), DevEnvFx.SaysTheCreateSeededTheCreatorAs)
                const creator = await DevEnvFx.Client(port, DevEnvFx.CreatorEmail(), await EnvironmentEndpoints.LocalAdminPasswordOf(record, root))
                clients.push(creator)
                // tenant-admin: a test user in the local IdP, units, BasicUser; Plexus: deploy hr
                for (const user of [DevEnvFx.Tess, DevEnvFx.Ulla, DevEnvFx.Vic])
                {
                    await service.AdminCreateAccount(DevEnvFx.Name, { email: DevEnvFx.EmailOf(user), principalId: user, password: DevEnvFx.UserPassword })
                    // the identity RBAC still gates the endpoints (the coarse role); tier 1 decides the rows
                    await service.AdminGrantRole(DevEnvFx.Name, { subject: user, role: DevEnvFx.CoarseRole, resourceKind: DevEnvFx.TenantKind, resourcePath: [] })
                }
                await service.AdminSetSecurityModel(DevEnvFx.Name, DevEnvFx.Setting())
                const compiler = new EnvironmentFixture()
                try
                {
                    await compiler.Package(DevEnvFx.Hr.id, DevEnvFx.Hr.version, DevEnvFx.HrTodl)
                    await CapstoneFx.DeployThrough(creator, compiler.PackagesDir, CapstoneFx.V1, [DevEnvFx.Hr])
                }
                finally
                {
                    await compiler.Dispose()
                }
                await DevEnvFx.Insert(creator, DevEnvFx.Root1)
                await DevEnvFx.Insert(creator, DevEnvFx.Root2)
                const tess = await DevEnvFx.Client(port, DevEnvFx.EmailOf(DevEnvFx.Tess), DevEnvFx.UserPassword)
                clients.push(tess)
                await DevEnvFx.Insert(tess, DevEnvFx.Own)
                for (const peer of [DevEnvFx.Ulla, DevEnvFx.Vic])
                {
                    const client = await DevEnvFx.Client(port, DevEnvFx.EmailOf(peer), DevEnvFx.UserPassword)
                    clients.push(client)
                    await DevEnvFx.Insert(client, peer + DevEnvFx.PeerSuffix)
                }
                const ullas = DevEnvFx.Ulla + DevEnvFx.PeerSuffix
                const vics = DevEnvFx.Vic + DevEnvFx.PeerSuffix
                assert.deepEqual(await DevEnvFx.Names(creator), [DevEnvFx.Root1, DevEnvFx.Root2, DevEnvFx.Own, ullas, vics], DevEnvFx.SaysTheCreatorReadsEveryRow)
                assert.deepEqual(await DevEnvFx.Names(tess), [DevEnvFx.Own, ullas], DevEnvFx.SaysBasicUserReadsAtBUDepthUnit)
            }
            finally
            {
                for (const client of clients) await client.DisposeAsync()
                await docker.Down()
                rmSync(root, { recursive: true, force: true })
            }
        })
    })
})
