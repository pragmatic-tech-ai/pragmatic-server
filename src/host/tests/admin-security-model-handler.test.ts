import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InMemoryMessageSocket, WebSocketMessageReader, WebSocketMessageWriter, createMessageConnection, NullLogger, AdminProtocol, ResponseError, ErrorCodes } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { MessageConnection, SecurityModelDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { AccessLevel, PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import type { PragmaticServer } from '../../pragmatic-server.js'
import { AdminService } from '../admin-service.js'
import type { ISecuritySettingAdmin } from '../admin-service.js'
import { InvalidParamsPrefix } from '../invalid-params-prefix.js'
import { SecurityModelWire } from '../security-model-wire.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import { SecuritySettingIssue, SecuritySettingIssueCode } from '../environment/security-setting-catalog-check.js'
import { EnvironmentFixture } from '../environment/tests/environment-fixture.js'
import { Tier1Fx } from '../environment/tests/tier1-fixture.js'

/** An admin client over `server`'s admin service (`security` as the server gives it, unless overridden). */
class AdminClient
{
    private static readonly NoPacks = { Invalidate: async () => undefined, AllowScripts: async () => undefined, DenyScripts: async () => undefined, ListScriptAllowlist: async () => [] }

    private constructor(public readonly Client: MessageConnection, private readonly handler: ServerConnectionHandler)
    {
    }

    public static async Open(server: PragmaticServer, context: AccessContext, security: ISecuritySettingAdmin | undefined): Promise<AdminClient>
    {
        const pack = await server.Pack()
        const admin = new AdminService(pack.Grants, pack.Audit, await server.TenantConfigStore(), server.Tenant(), async () => undefined, pack.Accounts, pack.Registrar, pack.Tokens, AdminClient.NoPacks, security)
        const languageService = { GraphChanged: { subscribe: () => ({ dispose: () => undefined }) }, BuildStateChanged: { subscribe: () => ({ dispose: () => undefined }) } } as unknown as ILanguageService
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(serverSocket, languageService, {} as unknown as SolutionManagerService, context, undefined, undefined, undefined, undefined, undefined, undefined, admin)
        const client = createMessageConnection(new WebSocketMessageReader(clientSocket), new WebSocketMessageWriter(clientSocket), NullLogger)
        client.listen()
        return new AdminClient(client, handler)
    }

    public static async Run(body: (server: PragmaticServer, admin: AdminClient, fx: EnvironmentFixture) => Promise<void>, security?: ISecuritySettingAdmin | null): Promise<void>
    {
        await Tier1Fx.Run({ Identity: true, SecurityModel: Tier1Fx.Setting() }, async (fx, server) =>
        {
            const admin = await AdminClient.Open(server, Tier1Fx.Context(Tier1Fx.Admin), security === null ? undefined : security ?? await server.SecurityAdmin())
            try
            {
                await body(server, admin, fx)
            }
            finally
            {
                admin.Client.dispose()
                admin.handler.Dispose()
            }
        })
    }

    public Set(model: SecurityModelDto): Promise<unknown>
    {
        return this.Client.sendRequest(AdminProtocol.SetSecurityModel, { securityModel: model })
    }

    public static async Stored(server: PragmaticServer): Promise<string>
    {
        return JSON.stringify((await (await server.TenantConfigStore()).Get(EnvironmentFixture.TenantId))?.SecurityModel)
    }

    public static Refused(code: number, message: string): (error: unknown) => boolean
    {
        return error => error instanceof ResponseError && error.code === code && error.message === message
    }
}

class HandlerFx
{
    public static readonly UnknownUnit = 'nope'
    public static readonly UnknownUnitReason = 'unknown business unit: nope'

    public static Narrowed(): SecurityModelDto
    {
        const override = Tier1Fx.Override(Tier1Fx.ProjectManager, Tier1Fx.Project, PrivilegeAction.Read, AccessLevel.BusinessUnit)
        return SecurityModelWire.ToDto(Tier1Fx.Setting({ RoleAssignments: [{ role: Tier1Fx.ProjectManager, principalIds: [Tier1Fx.Pm], teamIds: [] }], RoleOverrides: [override] }))
    }
}

test('set then get returns the setting', async () =>
{
    await AdminClient.Run(async (_server, admin) =>
    {
        const model = HandlerFx.Narrowed()
        assert.deepEqual(await admin.Set(model), { ok: true })
        assert.deepEqual(await admin.Client.sendRequest(AdminProtocol.GetSecurityModel), model)
    })
})

test('refused set leaves the setting unchanged', async () =>
{
    await AdminClient.Run(async (server, admin) =>
    {
        const before = await AdminClient.Stored(server)
        const catalogIssue = SecurityModelWire.ToDto(Tier1Fx.Setting({ RoleOverrides: [Tier1Fx.Override(Tier1Fx.AccountReader, Tier1Fx.Account, PrivilegeAction.Read, AccessLevel.BusinessUnit)] }))
        const reason = InvalidParamsPrefix.Text + new SecuritySettingIssue(SecuritySettingIssueCode.OrganizationOwnedDepth, Tier1Fx.Account).Message
        await assert.rejects(admin.Set(catalogIssue), AdminClient.Refused(ErrorCodes.InvalidParams, reason), 'a catalog issue names its fixed reason')
        assert.equal(await AdminClient.Stored(server), before, 'the stored setting is byte-equal')
        const valid = SecurityModelWire.ToDto(Tier1Fx.Setting())
        const structural: SecurityModelDto = { ...valid, users: [{ principalId: Tier1Fx.Alice, businessUnitId: HandlerFx.UnknownUnit }] }
        await assert.rejects(admin.Set(structural), AdminClient.Refused(ErrorCodes.InvalidParams, InvalidParamsPrefix.Text + HandlerFx.UnknownUnitReason), 'an S3 InvalidSecurityModelError names its issue')
        assert.equal(await AdminClient.Stored(server), before)
    })
})

test('development tenant refuses the setting', async () =>
{
    // a Development tenant's server gives the admin service no security setting (PragmaticServer.SecurityAdmin, PR13)
    await AdminClient.Run(async (server, admin) =>
    {
        const before = await AdminClient.Stored(server)
        await assert.rejects(admin.Set(HandlerFx.Narrowed()), (error: unknown) => error instanceof ResponseError && error.code === ErrorCodes.InvalidRequest)
        assert.equal(await AdminClient.Stored(server), before)
    }, null)
})

test('set invalidates the scope', async () =>
{
    await AdminClient.Run(async (server, admin, fx) =>
    {
        await admin.Set(SecurityModelWire.ToDto(Tier1Fx.Setting({ RoleAssignments: [{ role: Tier1Fx.ProjectManager, principalIds: [Tier1Fx.Pm], teamIds: [] }] })))
        await fx.Seed([Tier1Fx.Owned(Tier1Fx.Project, Tier1Fx.Sales, Tier1Fx.Pm, Tier1Fx.Sales), Tier1Fx.Owned(Tier1Fx.Project, Tier1Fx.Marketing, Tier1Fx.Bob, Tier1Fx.Marketing)])
        const before = await Tier1Fx.Scope(server, Tier1Fx.Pm)
        assert.deepEqual(await Tier1Fx.Names(server, Tier1Fx.Pm, Tier1Fx.Project), [Tier1Fx.Marketing, Tier1Fx.Sales])
        await admin.Set(HandlerFx.Narrowed())
        const after = await Tier1Fx.Scope(server, Tier1Fx.Pm)
        assert.notEqual(after.Digest, before.Digest)
        assert.deepEqual(await Tier1Fx.Names(server, Tier1Fx.Pm, Tier1Fx.Project), [Tier1Fx.Sales], 'the new override applies')
    })
})
