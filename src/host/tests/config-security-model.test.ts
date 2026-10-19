import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { InMemoryMessageSocket, WebSocketMessageReader, WebSocketMessageWriter, createMessageConnection, NullLogger, AdminProtocol } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { MessageConnection, IdentityConfigDto, SecurityModelDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy, PrivilegeAction, AccessLevel } from '@pragmatic-tech-ai/todl-identity'
import type { IAuditSink, AuditEvent } from '@pragmatic-tech-ai/todl-identity'
import { InMemoryRoleGrantStore, LocalAccountStore, ServiceTokenStore, LocalAccountRegistrar, EncryptedSecretStore, Argon2PasswordHasher } from '@pragmatic-tech-ai/todl-identity-local'
import { InMemoryTenantConfigStore } from '@pragmatic-tech-ai/todl-identity-host'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import { AdminService } from '../admin-service.js'
import { TenantReadAuthorization } from '../cypher/read-filter-source.js'

class NullAuditSink implements IAuditSink
{
    public async Record(_event: AuditEvent): Promise<void>
    {
    }
}

class SecurityModelFixture
{
    public static readonly TenantId = 't1'
    public static readonly PrincipalId = 'p1'
    public static readonly Widget = 'shop.Widget'
    public static readonly TenantName = 'Tenant One'
    public static readonly PackId = 'local'
    public static readonly DelegationDepth = 'AuthnDirectory'
    public static readonly RootUnitId = 'root'
    public static readonly RootUnitName = 'Root'
    public static readonly NoneMessage = 'none'
    public static readonly NoGraphMessage = 'no graph'
    public static readonly ReaderRoleId = 'r'
    public static readonly ReaderRoleName = 'R'
    public static readonly MalformedField = /securityModel/
    private static readonly SharedTenant = new Tenant(SecurityModelFixture.TenantId, TenantKind.SelfHosted, SecurityModelFixture.TenantName)
    public readonly Configs = new InMemoryTenantConfigStore()
    public readonly Client: MessageConnection
    public Authorization = new TenantReadAuthorization(this.Configs)
    private readonly handler: ServerConnectionHandler

    public constructor()
    {
        const tenant = SecurityModelFixture.SharedTenant
        const audit = new NullAuditSink()
        const accounts = new LocalAccountStore()
        const registrar = new LocalAccountRegistrar(accounts, new EncryptedSecretStore(randomBytes(32)), new Argon2PasswordHasher(), audit)
        // Evict stands in for the real DisposeTenant: the next read cold-rebuilds from the store.
        const evict = async (): Promise<void> =>
        {
            this.Authorization = new TenantReadAuthorization(this.Configs)
        }
        const admin = new AdminService(new InMemoryRoleGrantStore(), audit, this.Configs, tenant, evict, accounts, registrar, new ServiceTokenStore(), { Invalidate: async () => undefined, AllowScripts: async () => undefined, DenyScripts: async () => undefined, ListScriptAllowlist: async () => [] }, this.Authorization)
        const languageService = { GraphChanged: { subscribe: () => ({ dispose: () => undefined }) }, BuildStateChanged: { subscribe: () => ({ dispose: () => undefined }) } } as unknown as ILanguageService
        const manager = {} as unknown as SolutionManagerService
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        this.handler = ServerConnectionHandler.Attach(serverSocket, languageService, manager, this.Context(), () => Promise.reject(new Error(SecurityModelFixture.NoneMessage)), () => Promise.reject(new Error(SecurityModelFixture.NoGraphMessage)), undefined, undefined, undefined, undefined, admin)
        this.Client = createMessageConnection(new WebSocketMessageReader(clientSocket), new WebSocketMessageWriter(clientSocket), NullLogger)
        this.Client.listen()
    }

    public Context(): AccessContext
    {
        const tenant = SecurityModelFixture.SharedTenant
        const principal = new Principal(SecurityModelFixture.PrincipalId, SecurityModelFixture.TenantId, PrincipalKind.User, new Map(), [])
        const grants = [new Grant(SecurityModelFixture.PrincipalId, Role.Owner, new ResourceRef(ResourceKind.Tenant, SecurityModelFixture.TenantId, []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    public static Dto(securityModel?: SecurityModelDto): IdentityConfigDto
    {
        const dto: IdentityConfigDto = { packId: SecurityModelFixture.PackId, delegationDepth: SecurityModelFixture.DelegationDepth, providerSettings: {}, groupRoleMap: {}, claimsMapping: {} }
        return securityModel === undefined ? dto : { ...dto, securityModel }
    }

    public static MinimalModel(): SecurityModelDto
    {
        return { businessUnits: [{ id: SecurityModelFixture.RootUnitId, name: SecurityModelFixture.RootUnitName }], teams: [], membership: { claimsMapping: [], overrides: [] }, ownershipRules: [] } as unknown as SecurityModelDto
    }

    /** Model granting the principal Read on the widget concept at Organization level. */
    public static ReadingModel(): SecurityModelDto
    {
        return {
            ...(SecurityModelFixture.MinimalModel() as object),
            roles: [{ id: SecurityModelFixture.ReaderRoleId, name: SecurityModelFixture.ReaderRoleName, privileges: [{ action: PrivilegeAction.Read, concept: SecurityModelFixture.Widget, level: AccessLevel.Organization }] }],
            roleAssignment: { claimsMapping: [], overrides: [{ principalId: SecurityModelFixture.PrincipalId, roles: [SecurityModelFixture.ReaderRoleId] }], teamRoles: [] },
        } as unknown as SecurityModelDto
    }

    public async ReadLevel(): Promise<AccessLevel>
    {
        const context = this.Context()
        const evaluator = await this.Authorization.EvaluatorForContext(context)
        return evaluator.EffectiveLevel(context.Principal, PrivilegeAction.Read, SecurityModelFixture.Widget)
    }

    public Dispose(): void
    {
        this.Client.dispose()
        this.handler.Dispose()
    }
}

class Case
{
    public static async Run(body: (fx: SecurityModelFixture) => Promise<void>): Promise<void>
    {
        const fx = new SecurityModelFixture()
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

test('a valid securityModel round-trips through SetConfig and GetConfig', async () =>
{
    await Case.Run(async fx =>
    {
        const model = SecurityModelFixture.MinimalModel()
        await fx.Client.sendRequest(AdminProtocol.SetConfig, SecurityModelFixture.Dto(model))
        const got = await fx.Client.sendRequest(AdminProtocol.GetConfig)
        assert.deepEqual(got.securityModel, model)
    })
})

test('a malformed securityModel is rejected as invalid params', async () =>
{
    await Case.Run(async fx =>
    {
        const bad = { ...(SecurityModelFixture.MinimalModel() as object), teams: [{ id: 't', name: 'T', owningBusinessUnit: 'nope' }] } as unknown as SecurityModelDto
        await assert.rejects(fx.Client.sendRequest(AdminProtocol.SetConfig, SecurityModelFixture.Dto(bad)), SecurityModelFixture.MalformedField)
    })
})

test('SetConfig without a securityModel leaves it undefined', async () =>
{
    await Case.Run(async fx =>
    {
        await fx.Client.sendRequest(AdminProtocol.SetConfig, SecurityModelFixture.Dto())
        const got = await fx.Client.sendRequest(AdminProtocol.GetConfig)
        assert.equal(got.securityModel, undefined)
    })
})

test('a second SetConfig is re-read by a freshly resolved evaluator after eviction', async () =>
{
    await Case.Run(async fx =>
    {
        await fx.Client.sendRequest(AdminProtocol.SetConfig, SecurityModelFixture.Dto(SecurityModelFixture.ReadingModel()))
        assert.equal(await fx.ReadLevel(), AccessLevel.Organization)
        await fx.Client.sendRequest(AdminProtocol.SetConfig, SecurityModelFixture.Dto(SecurityModelFixture.MinimalModel()))
        assert.notEqual(await fx.ReadLevel(), AccessLevel.Organization)
    })
})
