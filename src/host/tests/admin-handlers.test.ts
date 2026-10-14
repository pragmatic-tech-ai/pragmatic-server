import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InMemoryMessageSocket, WebSocketMessageReader, WebSocketMessageWriter, createMessageConnection, NullLogger, AdminProtocol, ResponseError, ErrorCodes } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { MessageConnection } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import type { IAuditSink, AuditEvent } from '@pragmatic-tech-ai/todl-identity'
import { InMemoryRoleGrantStore } from '@pragmatic-tech-ai/todl-identity-local'
import { InMemoryTenantConfigStore } from '@pragmatic-tech-ai/todl-identity-host'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import { AdminService } from '../admin-service.js'

class NullAuditSink implements IAuditSink
{
    public async Record(_event: AuditEvent): Promise<void>
    {
    }
}

class AdminFixture
{
    public readonly Grants = new InMemoryRoleGrantStore()
    public readonly Handler: ServerConnectionHandler
    public readonly Client: MessageConnection

    public constructor(role: Role)
    {
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal('p1', 't1', PrincipalKind.User, new Map(), [])
        const context = new AccessContext(principal, tenant, [new Grant('p1', role, new ResourceRef(ResourceKind.Tenant, 't1', []))], new ResourceAuthorizationPolicy())
        const admin = new AdminService(this.Grants, new NullAuditSink(), new InMemoryTenantConfigStore(), tenant, async () => undefined)
        const languageService = { GraphChanged: { subscribe: () => ({ dispose: () => undefined }) } } as unknown as ILanguageService
        const manager = {} as unknown as SolutionManagerService
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        this.Handler = ServerConnectionHandler.Attach(serverSocket, languageService, manager, context, () => Promise.reject(new Error('none')), undefined, undefined, undefined, undefined, admin)
        this.Client = createMessageConnection(new WebSocketMessageReader(clientSocket), new WebSocketMessageWriter(clientSocket), NullLogger)
        this.Client.listen()
    }

    public Dispose(): void
    {
        this.Client.dispose()
        this.Handler.Dispose()
    }
}

test('grant then list round-trips a GrantDto under the connection tenant', async () =>
{
    const fx = new AdminFixture(Role.Owner)
    try
    {
        const ack = await fx.Client.sendRequest(AdminProtocol.GrantRole, { subject: 'bob', role: 'Editor' })
        assert.deepEqual(ack, { ok: true })
        const list = await fx.Client.sendRequest(AdminProtocol.ListGrants, { subject: 'bob' })
        assert.deepEqual(list, [{ subject: 'bob', role: 'Editor', resourceKind: 'Tenant', resourcePath: [] }])
        const stored = await fx.Grants.GrantsFor('bob', new Tenant('t1', TenantKind.SelfHosted, 'x'))
        assert.equal(stored[0].Resource.TenantId, 't1')
        const cfgErr = await fx.Client.sendRequest(AdminProtocol.GetConfig).then(() => undefined, (e: unknown) => e)
        assert.equal((cfgErr as ResponseError<unknown>).code, ErrorCodes.InvalidRequest)
        await fx.Client.sendRequest(AdminProtocol.SetConfig, { packId: 'local', delegationDepth: 'AuthnDirectory', providerSettings: {}, groupRoleMap: { g: 'Viewer' }, claimsMapping: {} })
        const config = await fx.Client.sendRequest(AdminProtocol.GetConfig)
        assert.equal(config.groupRoleMap.g, 'Viewer')
        await fx.Client.sendRequest(AdminProtocol.RevokeRole, { subject: 'bob', role: 'Editor' })
        assert.deepEqual(await fx.Client.sendRequest(AdminProtocol.ListGrants, { subject: 'bob' }), [])
    }
    finally
    {
        fx.Dispose()
    }
})

test('a Viewer is rejected on every admin method', async () =>
{
    const fx = new AdminFixture(Role.Viewer)
    try
    {
        const calls: Promise<unknown>[] = [
            fx.Client.sendRequest(AdminProtocol.ListGrants, { subject: 'bob' }),
            fx.Client.sendRequest(AdminProtocol.GrantRole, { subject: 'bob', role: 'Editor' }),
            fx.Client.sendRequest(AdminProtocol.RevokeRole, { subject: 'bob', role: 'Editor' }),
            fx.Client.sendRequest(AdminProtocol.GetConfig),
            fx.Client.sendRequest(AdminProtocol.SetConfig, { packId: 'local', delegationDepth: 'AuthnDirectory', providerSettings: {}, groupRoleMap: {}, claimsMapping: {} }),
        ]
        for (const call of calls)
        {
            await assert.rejects(call, (e: unknown) => e instanceof ResponseError)
        }
    }
    finally
    {
        fx.Dispose()
    }
})

test('an unknown role is InvalidParams and mutates nothing', async () =>
{
    const fx = new AdminFixture(Role.Owner)
    try
    {
        await assert.rejects(fx.Client.sendRequest(AdminProtocol.GrantRole, { subject: 'bob', role: 'Wizard' }), (e: unknown) =>
            e instanceof ResponseError && e.code === ErrorCodes.InvalidParams && !e.message.includes('Wizard'))
        const stored = await fx.Grants.GrantsFor('bob', new Tenant('t1', TenantKind.SelfHosted, 'x'))
        assert.equal(stored.length, 0)
    }
    finally
    {
        fx.Dispose()
    }
})
