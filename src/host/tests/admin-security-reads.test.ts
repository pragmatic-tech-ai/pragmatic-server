import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InMemoryMessageSocket, WebSocketMessageReader, WebSocketMessageWriter, createMessageConnection, NullLogger, AdminProtocol, ResponseError, ErrorCodes } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { MessageConnection, SecurityCatalogDto, TeamMemberDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { TeamMemberOrigin } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { AccessContext, BaseRole, Grant, IdpDirectorySnapshot, IdpUserState, Principal, PrincipalKind, ResourceAuthorizationPolicy, ResourceKind, ResourceRef, Role, Tenant, TenantKind } from '@pragmatic-tech-ai/todl-identity'
import type { AccessContext as AccessContextType, ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import type { PragmaticServer } from '../../pragmatic-server.js'
import { AdminService } from '../admin-service.js'
import type { ISecuritySettingAdmin } from '../admin-service.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import { EnvironmentSecurityAdmin } from '../environment/environment-security-admin.js'
import { EnvironmentFixture } from '../environment/tests/environment-fixture.js'
import { Tier1Fx } from '../environment/tests/tier1-fixture.js'

class ReadsClient
{
    private static readonly NoPacks = { Invalidate: async () => undefined, AllowScripts: async () => undefined, DenyScripts: async () => undefined, ListScriptAllowlist: async () => [] }
    private static readonly SyncedOnly = 'synced-only'
    private static readonly Dual = 'dual'
    private static readonly ManualOnly = 'manual-only'
    private static readonly Group = 'g1'
    private static readonly TeamId = 'team1'

    private constructor(public readonly Client: MessageConnection, private readonly handler: ServerConnectionHandler)
    {
    }

    /** A team whose linked group is g1 and whose manual members are `dual` and `manual-only`. */
    public static TeamModel(): ISecurityModelConfig
    {
        return Tier1Fx.Setting({ Teams: [{ id: ReadsClient.TeamId, name: 'Team', businessUnitId: Tier1Fx.Sales, idpGroups: [ReadsClient.Group], manualMembers: [ReadsClient.Dual, ReadsClient.ManualOnly] }] })
    }

    /** An authoritative snapshot: g1 = {synced-only, dual}, synced-only disabled. */
    public static TeamSnapshot(): IdpDirectorySnapshot
    {
        return new IdpDirectorySnapshot(new Date(), true,
            new Map([[ReadsClient.SyncedOnly, IdpUserState.Disabled]]),
            new Map([[ReadsClient.Group, [ReadsClient.SyncedOnly, ReadsClient.Dual]]]))
    }

    public static async Open(server: PragmaticServer, context: AccessContextType, security: ISecuritySettingAdmin | undefined): Promise<ReadsClient>
    {
        const pack = await server.Pack()
        const admin = new AdminService(pack.Grants, pack.Audit, await server.TenantConfigStore(), server.Tenant(), async () => undefined, pack.Accounts, pack.Registrar, pack.Tokens, ReadsClient.NoPacks, security)
        const languageService = { GraphChanged: { subscribe: () => ({ dispose: () => undefined }) }, BuildStateChanged: { subscribe: () => ({ dispose: () => undefined }) } } as unknown as ILanguageService
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(serverSocket, languageService, {} as unknown as SolutionManagerService, context, undefined, undefined, undefined, undefined, undefined, undefined, admin)
        const client = createMessageConnection(new WebSocketMessageReader(clientSocket), new WebSocketMessageWriter(clientSocket), NullLogger)
        client.listen()
        return new ReadsClient(client, handler)
    }

    public Dispose(): void
    {
        this.Client.dispose()
        this.handler.Dispose()
    }

    /** A Runtime tenant with the team setting, a no-op directory sync so the hand-stored snapshot is not clobbered, and the stored snapshot. */
    public static async RunWithTeam(body: (server: PragmaticServer, admin: ReadsClient) => Promise<void>): Promise<void>
    {
        await Tier1Fx.Run({ Identity: true, SecurityModel: ReadsClient.TeamModel() }, async (_fx, server) =>
        {
            const pack = await server.Pack()
            await pack.IdpDirectory.Save(EnvironmentFixture.TenantId, ReadsClient.TeamSnapshot())
            const security = new EnvironmentSecurityAdmin(await server.SecuritySetting(), server.EnvironmentEngine(), { RunNow: async () => undefined }, server.SecurityChangeLog())
            const admin = await ReadsClient.Open(server, Tier1Fx.Context(Tier1Fx.Admin), security)
            try
            {
                await body(server, admin)
            }
            finally
            {
                admin.Dispose()
            }
        })
    }

    public static ViewerContext(): AccessContext
    {
        const tenant = new Tenant(EnvironmentFixture.TenantId, TenantKind.SelfHosted, 'Environment One')
        const principal = new Principal('viewer', EnvironmentFixture.TenantId, PrincipalKind.User, new Map(), [])
        const grants = [new Grant('viewer', Role.Viewer, new ResourceRef(ResourceKind.Tenant, EnvironmentFixture.TenantId, []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }
}

test('the catalog read returns the environment vocabulary, base roles first', async () =>
{
    await ReadsClient.RunWithTeam(async (_server, admin) =>
    {
        const catalog = await admin.Client.sendRequest(AdminProtocol.GetSecurityCatalog) as SecurityCatalogDto
        assert.equal(catalog.roles[0]?.name, BaseRole.SystemAdministrator)
        assert.ok(catalog.concepts.some(c => c.name === Tier1Fx.Employee && c.owned))
    })
})

test('team members carry their origin and a disabled identity is not listed', async () =>
{
    await ReadsClient.RunWithTeam(async (_server, admin) =>
    {
        const members = await admin.Client.sendRequest(AdminProtocol.ListTeamMembers, { teamId: 'team1' }) as TeamMemberDto[]
        assert.deepEqual(members, [
            { principalId: 'dual', origin: TeamMemberOrigin.Synced },
            { principalId: 'dual', origin: TeamMemberOrigin.Manual },
            { principalId: 'manual-only', origin: TeamMemberOrigin.Manual },
        ])
    })
})

test('an unknown team is invalid params', async () =>
{
    await ReadsClient.RunWithTeam(async (_server, admin) =>
    {
        await assert.rejects(
            admin.Client.sendRequest(AdminProtocol.ListTeamMembers, { teamId: 'nope' }),
            (error: unknown) => error instanceof ResponseError && error.code === ErrorCodes.InvalidParams && error.message.includes('unknown team'))
    })
})

test('both reads refuse a Development tenant with InvalidRequest', async () =>
{
    await Tier1Fx.Run({ Identity: true, SecurityModel: ReadsClient.TeamModel() }, async (_fx, server) =>
    {
        // security undefined models a Development tenant (PragmaticServer.SecurityAdmin returns undefined there, PR13)
        const admin = await ReadsClient.Open(server, Tier1Fx.Context(Tier1Fx.Admin), undefined)
        try
        {
            const refused = (error: unknown): boolean => error instanceof ResponseError && error.code === ErrorCodes.InvalidRequest
            await assert.rejects(admin.Client.sendRequest(AdminProtocol.GetSecurityCatalog), refused)
            await assert.rejects(admin.Client.sendRequest(AdminProtocol.ListTeamMembers, { teamId: 'team1' }), refused)
        }
        finally
        {
            admin.Dispose()
        }
    })
})

test('both reads require administer', async () =>
{
    await Tier1Fx.Run({ Identity: true, SecurityModel: ReadsClient.TeamModel() }, async (_fx, server) =>
    {
        const admin = await ReadsClient.Open(server, ReadsClient.ViewerContext(), undefined)
        try
        {
            const denied = (error: unknown): boolean => error instanceof ResponseError && error.code === ErrorCodes.InvalidRequest
            await assert.rejects(admin.Client.sendRequest(AdminProtocol.GetSecurityCatalog), denied, 'a Viewer cannot read the catalog')
            await assert.rejects(admin.Client.sendRequest(AdminProtocol.ListTeamMembers, { teamId: 'team1' }), denied, 'a Viewer cannot read team members')
        }
        finally
        {
            admin.Dispose()
        }
    })
})
