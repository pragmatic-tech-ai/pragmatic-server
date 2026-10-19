import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { InMemoryMessageSocket, WebSocketMessageReader, WebSocketMessageWriter, createMessageConnection, NullLogger, AdminProtocol, ResponseError, ErrorCodes } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { MessageConnection, SecurityModelDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy, IdentityConfig, DelegationDepth } from '@pragmatic-tech-ai/todl-identity'
import type { IAuditSink, AuditEvent } from '@pragmatic-tech-ai/todl-identity'
import { LocalAccountStore, ServiceTokenStore, LocalAccountRegistrar, EncryptedSecretStore, Argon2PasswordHasher, InMemoryRoleGrantStore } from '@pragmatic-tech-ai/todl-identity-local'
import { InMemoryTenantConfigStore } from '@pragmatic-tech-ai/todl-identity-host'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import { AdminService } from '../admin-service.js'
import type { ISecurityModelReload } from '../cypher/read-filter-source.js'

class NullAuditSink implements IAuditSink
{
    public async Record(_event: AuditEvent): Promise<void>
    {
    }
}

/** Records the tenant ids whose cached evaluator was dropped, so a test can prove the live reload fired. */
class RecordingReload implements ISecurityModelReload
{
    public readonly Invalidated: string[] = []

    public Invalidate(tenantId: string): void
    {
        this.Invalidated.push(tenantId)
    }
}

class SecurityModelHandlerFixture
{
    public static readonly TenantId = 't1'
    public static readonly PrincipalId = 'p1'
    public static readonly TenantName = 'Tenant One'
    public static readonly PackId = 'local'
    public static readonly RootUnitId = 'root'
    public static readonly RootUnitName = 'Root'
    public static readonly MalformedField = /securityModel/
    public static readonly NoneMessage = 'none'
    public static readonly NoGraphMessage = 'no graph'
    private static readonly SharedTenant = new Tenant(SecurityModelHandlerFixture.TenantId, TenantKind.SelfHosted, SecurityModelHandlerFixture.TenantName)

    public readonly Configs = new InMemoryTenantConfigStore()
    public readonly Reload = new RecordingReload()
    public readonly Client: MessageConnection
    private readonly role: Role
    private readonly handler: ServerConnectionHandler

    public constructor(role: Role = Role.Owner)
    {
        this.role = role
        const tenant = SecurityModelHandlerFixture.SharedTenant
        const audit = new NullAuditSink()
        const accounts = new LocalAccountStore()
        const registrar = new LocalAccountRegistrar(accounts, new EncryptedSecretStore(randomBytes(32)), new Argon2PasswordHasher(), audit)
        const admin = new AdminService(new InMemoryRoleGrantStore(), audit, this.Configs, tenant, async () => undefined, accounts, registrar, new ServiceTokenStore(), { Invalidate: async () => undefined, AllowScripts: async () => undefined, DenyScripts: async () => undefined, ListScriptAllowlist: async () => [] }, this.Reload)
        const languageService = { GraphChanged: { subscribe: () => ({ dispose: () => undefined }) }, BuildStateChanged: { subscribe: () => ({ dispose: () => undefined }) } } as unknown as ILanguageService
        const manager = {} as unknown as SolutionManagerService
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        this.handler = ServerConnectionHandler.Attach(serverSocket, languageService, manager, this.Context(), () => Promise.reject(new Error(SecurityModelHandlerFixture.NoneMessage)), () => Promise.reject(new Error(SecurityModelHandlerFixture.NoGraphMessage)), undefined, undefined, undefined, undefined, admin)
        this.Client = createMessageConnection(new WebSocketMessageReader(clientSocket), new WebSocketMessageWriter(clientSocket), NullLogger)
        this.Client.listen()
    }

    public Context(): AccessContext
    {
        const tenant = SecurityModelHandlerFixture.SharedTenant
        const principal = new Principal(SecurityModelHandlerFixture.PrincipalId, SecurityModelHandlerFixture.TenantId, PrincipalKind.User, new Map(), [])
        const grants = [new Grant(SecurityModelHandlerFixture.PrincipalId, this.role, new ResourceRef(ResourceKind.Tenant, SecurityModelHandlerFixture.TenantId, []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    /** Seeds a base config whose providerSettings must survive a security-model-only replacement. */
    public async SeedBaseConfig(): Promise<void>
    {
        await this.Configs.Save(SecurityModelHandlerFixture.TenantId, new IdentityConfig(SecurityModelHandlerFixture.PackId, DelegationDepth.AuthnDirectory, new Map([['k', 'v']]), new Map(), new Map()))
    }

    public static MinimalModel(): SecurityModelDto
    {
        return { businessUnits: [{ id: SecurityModelHandlerFixture.RootUnitId, name: SecurityModelHandlerFixture.RootUnitName }], teams: [], membership: { claimsMapping: [], overrides: [] }, ownershipRules: [] } as unknown as SecurityModelDto
    }

    public static MalformedModel(): SecurityModelDto
    {
        return { ...(SecurityModelHandlerFixture.MinimalModel() as object), teams: [{ id: 't', name: 'T', owningBusinessUnit: 'nope' }] } as unknown as SecurityModelDto
    }

    public Dispose(): void
    {
        this.Client.dispose()
        this.handler.Dispose()
    }
}

class Case
{
    public static async Run(body: (fx: SecurityModelHandlerFixture) => Promise<void>): Promise<void>
    {
        const fx = new SecurityModelHandlerFixture()
        try
        {
            await body(fx)
        }
        finally
        {
            fx.Dispose()
        }
    }
}

test('a malformed securityModel is rejected, the store is unchanged and no reload fires', async () =>
{
    await Case.Run(async fx =>
    {
        await fx.SeedBaseConfig()
        await assert.rejects(
            fx.Client.sendRequest(AdminProtocol.SetSecurityModel, { securityModel: SecurityModelHandlerFixture.MalformedModel() }),
            (e: unknown) => e instanceof ResponseError && e.code === ErrorCodes.InvalidParams && SecurityModelHandlerFixture.MalformedField.test(e.message))
        const stored = await fx.Configs.Get(SecurityModelHandlerFixture.TenantId)
        assert.equal(stored?.SecurityModel, undefined)
        assert.deepEqual(fx.Reload.Invalidated, [])
    })
})

test('a valid securityModel persists, preserves other config fields and fires the live reload', async () =>
{
    await Case.Run(async fx =>
    {
        await fx.SeedBaseConfig()
        // JSON-RPC carries a top-level absent value as null on the wire.
        assert.equal(await fx.Client.sendRequest(AdminProtocol.GetSecurityModel), null)
        const model = SecurityModelHandlerFixture.MinimalModel()
        const ack = await fx.Client.sendRequest(AdminProtocol.SetSecurityModel, { securityModel: model })
        assert.deepEqual(ack, { ok: true })
        const stored = await fx.Configs.Get(SecurityModelHandlerFixture.TenantId)
        assert.deepEqual(stored?.SecurityModel, model)
        // only the SecurityModel is replaced: the rest of the config is intact
        assert.equal(stored?.PackId, SecurityModelHandlerFixture.PackId)
        assert.equal(stored?.ProviderSettings.get('k'), 'v')
        assert.deepEqual(await fx.Client.sendRequest(AdminProtocol.GetSecurityModel), model)
        assert.deepEqual(fx.Reload.Invalidated, [SecurityModelHandlerFixture.TenantId])
    })
})

test('setting a securityModel with no stored config is InvalidRequest and fires no reload', async () =>
{
    await Case.Run(async fx =>
    {
        await assert.rejects(
            fx.Client.sendRequest(AdminProtocol.SetSecurityModel, { securityModel: SecurityModelHandlerFixture.MinimalModel() }),
            (e: unknown) => e instanceof ResponseError && e.code === ErrorCodes.InvalidRequest)
        assert.deepEqual(fx.Reload.Invalidated, [])
    })
})

test('a Viewer is rejected on both security-model methods and fires no reload', async () =>
{
    const fx = new SecurityModelHandlerFixture(Role.Viewer)
    try
    {
        await fx.SeedBaseConfig()
        const calls: Promise<unknown>[] = [
            fx.Client.sendRequest(AdminProtocol.GetSecurityModel),
            fx.Client.sendRequest(AdminProtocol.SetSecurityModel, { securityModel: SecurityModelHandlerFixture.MinimalModel() }),
        ]
        for (const call of calls)
        {
            await assert.rejects(call, (e: unknown) => e instanceof ResponseError && e.code === ErrorCodes.InvalidRequest)
        }
        const stored = await fx.Configs.Get(SecurityModelHandlerFixture.TenantId)
        assert.equal(stored?.SecurityModel, undefined)
        assert.deepEqual(fx.Reload.Invalidated, [])
    }
    finally
    {
        fx.Dispose()
    }
})
