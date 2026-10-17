import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { InMemoryMessageSocket, WebSocketMessageReader, WebSocketMessageWriter, createMessageConnection, NullLogger, AdminProtocol, ResponseError, ErrorCodes } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { MessageConnection } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import type { LocalAccount } from '@pragmatic-tech-ai/todl-identity'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import type { IAuditSink, AuditEvent } from '@pragmatic-tech-ai/todl-identity'
import { InMemoryRoleGrantStore, LocalAccountStore, ServiceTokenStore, LocalAccountRegistrar, EncryptedSecretStore, Argon2PasswordHasher } from '@pragmatic-tech-ai/todl-identity-local'
import { InMemoryTenantConfigStore } from '@pragmatic-tech-ai/todl-identity-host'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import { AdminService } from '../admin-service.js'
import { AdapterPackError, AdapterPackErrorKind } from '@pragmatic-tech-ai/todl-connectors-host'

class CapturingAuditSink implements IAuditSink
{
    public readonly Events: AuditEvent[] = []

    public async Record(event: AuditEvent): Promise<void>
    {
        this.Events.push(event)
    }

    public Serialized(): string
    {
        return JSON.stringify(this.Events)
    }
}

class FaultingAccountStore extends LocalAccountStore
{
    public static readonly FaultEmail = 'fault@example.com'
    public static readonly FaultMessage = 'disk exploded at /var/secret/path'

    public override async CreateAccount(tenant: Tenant, email: string, principalId: string, secretRef: string): Promise<LocalAccount>
    {
        if (email === FaultingAccountStore.FaultEmail)
        {
            throw new Error(FaultingAccountStore.FaultMessage)
        }
        return super.CreateAccount(tenant, email, principalId, secretRef)
    }
}

class AdminFixture
{
    public readonly Grants = new InMemoryRoleGrantStore()
    public readonly Tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
    public readonly Configs = new InMemoryTenantConfigStore()
    public readonly Audit = new CapturingAuditSink()
    public readonly Accounts = new FaultingAccountStore()
    public readonly InvalidatedPacks: string[] = []
    public readonly AllowedPacks: string[] = []
    public readonly DeniedPacks: string[] = []
    public readonly Handler: ServerConnectionHandler
    public readonly Client: MessageConnection

    private static readonly NoProviderMessage = 'no adapter pack provider is configured'

    public constructor(role: Role, faultPacks = false)
    {
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal('p1', 't1', PrincipalKind.User, new Map(), [])
        const context = new AccessContext(principal, tenant, [new Grant('p1', role, new ResourceRef(ResourceKind.Tenant, 't1', []))], new ResourceAuthorizationPolicy())
        const accounts = this.Accounts
        const registrar = new LocalAccountRegistrar(accounts, new EncryptedSecretStore(randomBytes(32)), new Argon2PasswordHasher(), this.Audit)
        const admin = new AdminService(this.Grants, this.Audit, this.Configs, tenant, async () => undefined, accounts, registrar, new ServiceTokenStore(), faultPacks
            ? {
                Invalidate: async () => { throw new AdapterPackError(AdapterPackErrorKind.ProviderNotConfigured, AdminFixture.NoProviderMessage) },
                AllowScripts: async () => { throw new AdapterPackError(AdapterPackErrorKind.ProviderNotConfigured, AdminFixture.NoProviderMessage) },
                DenyScripts: async () => { throw new AdapterPackError(AdapterPackErrorKind.ProviderNotConfigured, AdminFixture.NoProviderMessage) },
                ListScriptAllowlist: async () => { throw new AdapterPackError(AdapterPackErrorKind.ProviderNotConfigured, AdminFixture.NoProviderMessage) },
            }
            : {
                Invalidate: async name => { this.InvalidatedPacks.push(name) },
                AllowScripts: async name => { this.AllowedPacks.push(name) },
                DenyScripts: async name => { this.DeniedPacks.push(name) },
                ListScriptAllowlist: async () => ['seed-pack', ...this.AllowedPacks],
            })
        const languageService = { GraphChanged: { subscribe: () => ({ dispose: () => undefined }) }, BuildStateChanged: { subscribe: () => ({ dispose: () => undefined }) } } as unknown as ILanguageService
        const manager = {} as unknown as SolutionManagerService
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        this.Handler = ServerConnectionHandler.Attach(serverSocket, languageService, manager, context, () => Promise.reject(new Error('none')), () => Promise.reject(new Error('no graph')), undefined, undefined, undefined, undefined, admin)
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
            await assert.rejects(call, (e: unknown) => e instanceof ResponseError && e.code === ErrorCodes.InvalidRequest)
        }
        assert.equal((await fx.Grants.GrantsFor('bob', fx.Tenant)).length, 0)
        assert.equal(await fx.Configs.Get('t1'), null)
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

class Reject
{
    public static async Params(fx: AdminFixture, request: Promise<unknown>, field: string): Promise<void>
    {
        await assert.rejects(request, (e: unknown) =>
            e instanceof ResponseError && e.code === ErrorCodes.InvalidParams && e.message.includes(field))
        assert.equal((await fx.Grants.GrantsFor('bob', fx.Tenant)).length, 0)
        assert.equal(await fx.Configs.Get('t1'), null)
    }
}

const BadGrants: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['resourceKind', { subject: 'bob', role: 'Editor', resourceKind: 'Galaxy' }],
    ['resourcePath', { subject: 'bob', role: 'Editor', resourcePath: 'a/b' }],
    ['resourcePath', { subject: 'bob', role: 'Editor', resourcePath: { 0: 'a' } }],
    ['resourcePath', { subject: 'bob', role: 'Editor', resourcePath: ['a', 3] }],
    ['subject', { subject: '', role: 'Editor' }],
    ['subject', { role: 'Editor' }],
    ['subject', { subject: 7, role: 'Editor' }],
]

test('malformed grant fields are InvalidParams naming the field and mutate nothing', async () =>
{
    const fx = new AdminFixture(Role.Owner)
    try
    {
        for (const [field, dto] of BadGrants)
        {
            await Reject.Params(fx, fx.Client.sendRequest(AdminProtocol.GrantRole, dto as never), field)
            await Reject.Params(fx, fx.Client.sendRequest(AdminProtocol.RevokeRole, dto as never), field)
        }
        await Reject.Params(fx, fx.Client.sendRequest(AdminProtocol.ListGrants, { subject: '' }), 'subject')
    }
    finally
    {
        fx.Dispose()
    }
})

const GoodConfig = { packId: 'local', delegationDepth: 'AuthnDirectory', providerSettings: {}, groupRoleMap: {}, claimsMapping: {} }

const BadConfigs: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['packId', { ...GoodConfig, packId: '' }],
    ['packId', { ...GoodConfig, packId: 5 }],
    ['delegationDepth', { ...GoodConfig, delegationDepth: 'Everything' }],
    ['providerSettings', { ...GoodConfig, providerSettings: [] }],
    ['providerSettings', { ...GoodConfig, providerSettings: null }],
    ['providerSettings', { ...GoodConfig, providerSettings: { a: { b: 'c' } } }],
    ['claimsMapping', { ...GoodConfig, claimsMapping: { a: 1 } }],
    ['groupRoleMap', { ...GoodConfig, groupRoleMap: { g: 'Wizard' } }],
    ['groupRoleMap', { ...GoodConfig, groupRoleMap: { g: 3 } }],
]

test('malformed config fields are InvalidParams naming the field and store nothing', async () =>
{
    const fx = new AdminFixture(Role.Owner)
    try
    {
        for (const [field, dto] of BadConfigs)
        {
            await Reject.Params(fx, fx.Client.sendRequest(AdminProtocol.SetConfig, dto as never), field)
        }
    }
    finally
    {
        fx.Dispose()
    }
})

test('revoking your own tenant-Owner grant is InvalidRequest and leaves the grant', async () =>
{
    const fx = new AdminFixture(Role.Owner)
    try
    {
        await fx.Grants.Save(new Grant('p1', Role.Owner, new ResourceRef(ResourceKind.Tenant, 't1', [])))
        await assert.rejects(fx.Client.sendRequest(AdminProtocol.RevokeRole, { subject: 'p1', role: 'Owner' }), (e: unknown) =>
            e instanceof ResponseError && e.code === ErrorCodes.InvalidRequest)
        assert.equal((await fx.Grants.GrantsFor('p1', fx.Tenant)).length, 1)
    }
    finally
    {
        fx.Dispose()
    }
})

test('a tenant or tenantId field in the DTO is ignored: the connection tenant is used', async () =>
{
    const fx = new AdminFixture(Role.Owner)
    try
    {
        await fx.Client.sendRequest(AdminProtocol.GrantRole, { subject: 'bob', role: 'Editor', tenant: 'evil', tenantId: 'evil' } as never)
        const stored = await fx.Grants.GrantsFor('bob', fx.Tenant)
        assert.equal(stored.length, 1)
        assert.equal(stored[0].Resource.TenantId, 't1')
    }
    finally
    {
        fx.Dispose()
    }
})

class AccountTokenCases
{
    public static readonly Password = 'S3cret-pass-phrase-xyz'
    public static readonly Email = 'carol@example.com'
    public static readonly Principal = 'carol'

    public static async Create(fx: AdminFixture): Promise<void>
    {
        await fx.Client.sendRequest(AdminProtocol.CreateAccount, { email: AccountTokenCases.Email, principalId: AccountTokenCases.Principal, password: AccountTokenCases.Password })
    }

    public static async AccountCount(fx: AdminFixture): Promise<number>
    {
        return (await fx.Accounts.ListAccounts(fx.Tenant)).length
    }

    public static async Invalid(request: Promise<unknown>, field: string): Promise<void>
    {
        await assert.rejects(request, (e: unknown) =>
            e instanceof ResponseError && e.code === ErrorCodes.InvalidParams && e.message.includes(field))
    }
}

test('a Viewer is rejected on every account and token method', async () =>
{
    const fx = new AdminFixture(Role.Viewer)
    try
    {
        const calls: Promise<unknown>[] = [
            fx.Client.sendRequest(AdminProtocol.ListAccounts),
            fx.Client.sendRequest(AdminProtocol.CreateAccount, { email: AccountTokenCases.Email, principalId: AccountTokenCases.Principal, password: AccountTokenCases.Password }),
            fx.Client.sendRequest(AdminProtocol.DisableAccount, { principalId: AccountTokenCases.Principal }),
            fx.Client.sendRequest(AdminProtocol.ListTokens),
            fx.Client.sendRequest(AdminProtocol.IssueToken, { principalId: AccountTokenCases.Principal, scopes: [], expiresInSeconds: null }),
            fx.Client.sendRequest(AdminProtocol.RevokeToken, { tokenRef: 'x' }),
        ]
        for (const call of calls)
        {
            await assert.rejects(call, (e: unknown) => e instanceof ResponseError && e.code === ErrorCodes.InvalidRequest)
        }
        assert.equal(await AccountTokenCases.AccountCount(fx), 0)
    }
    finally
    {
        fx.Dispose()
    }
})

test('create then list shows the account; the password never reaches audit or the list', async () =>
{
    const fx = new AdminFixture(Role.Owner)
    try
    {
        await AccountTokenCases.Create(fx)
        const list = await fx.Client.sendRequest(AdminProtocol.ListAccounts)
        assert.deepEqual(list, [{ principalId: AccountTokenCases.Principal, email: AccountTokenCases.Email, disabled: false }])
        assert.equal(fx.Audit.Serialized().includes(AccountTokenCases.Password), false)
        assert.equal(JSON.stringify(list).includes(AccountTokenCases.Password), false)
        await fx.Client.sendRequest(AdminProtocol.DisableAccount, { principalId: AccountTokenCases.Principal })
        assert.equal((await fx.Client.sendRequest(AdminProtocol.ListAccounts))[0]!.disabled, true)
    }
    finally
    {
        fx.Dispose()
    }
})

test('a duplicate account create is InvalidRequest and disabling an unknown principal is InvalidRequest', async () =>
{
    const fx = new AdminFixture(Role.Owner)
    try
    {
        await AccountTokenCases.Create(fx)
        await assert.rejects(AccountTokenCases.Create(fx), (e: unknown) => e instanceof ResponseError && e.code === ErrorCodes.InvalidRequest)
        await assert.rejects(fx.Client.sendRequest(AdminProtocol.DisableAccount, { principalId: 'nobody' }), (e: unknown) =>
            e instanceof ResponseError && e.code === ErrorCodes.InvalidRequest)
        assert.equal(await AccountTokenCases.AccountCount(fx), 1)
    }
    finally
    {
        fx.Dispose()
    }
})

test('empty or missing account and token fields are InvalidParams naming the field', async () =>
{
    const fx = new AdminFixture(Role.Owner)
    try
    {
        const ok = { email: AccountTokenCases.Email, principalId: AccountTokenCases.Principal, password: AccountTokenCases.Password }
        await AccountTokenCases.Invalid(fx.Client.sendRequest(AdminProtocol.CreateAccount, { ...ok, email: '' }), 'email')
        await AccountTokenCases.Invalid(fx.Client.sendRequest(AdminProtocol.CreateAccount, { ...ok, principalId: '' }), 'principalId')
        await AccountTokenCases.Invalid(fx.Client.sendRequest(AdminProtocol.CreateAccount, { ...ok, password: '' }), 'password')
        await AccountTokenCases.Invalid(fx.Client.sendRequest(AdminProtocol.DisableAccount, { principalId: '' }), 'principalId')
        await AccountTokenCases.Invalid(fx.Client.sendRequest(AdminProtocol.IssueToken, { principalId: '', scopes: [], expiresInSeconds: null }), 'principalId')
        await AccountTokenCases.Invalid(fx.Client.sendRequest(AdminProtocol.IssueToken, { principalId: 'a', scopes: 'x' } as never), 'scopes')
        await AccountTokenCases.Invalid(fx.Client.sendRequest(AdminProtocol.RevokeToken, { tokenRef: '' }), 'tokenRef')
        assert.equal(await AccountTokenCases.AccountCount(fx), 0)
    }
    finally
    {
        fx.Dispose()
    }
})

test('a bad expiresInSeconds is InvalidParams naming the field and issues no token', async () =>
{
    const fx = new AdminFixture(Role.Owner)
    try
    {
        for (const bad of [0, -1, 1.5, 'x'])
        {
            await AccountTokenCases.Invalid(fx.Client.sendRequest(AdminProtocol.IssueToken, { principalId: 'carol', scopes: [], expiresInSeconds: bad } as never), 'expiresInSeconds')
        }
        assert.deepEqual(await fx.Client.sendRequest(AdminProtocol.ListTokens), [])
    }
    finally
    {
        fx.Dispose()
    }
})

test('issue returns the one-time token; list and audit never carry it; revoke flips revoked; unknown revoke is InvalidRequest', async () =>
{
    const fx = new AdminFixture(Role.Owner)
    try
    {
        const issued = await fx.Client.sendRequest(AdminProtocol.IssueToken, { principalId: 'carol', scopes: ['read'], expiresInSeconds: 60 })
        assert.ok(issued.token.length > 0)
        assert.equal(issued.principalId, 'carol')
        assert.deepEqual(issued.scopes, ['read'])
        assert.notEqual(issued.expiresAt, null)
        const list = await fx.Client.sendRequest(AdminProtocol.ListTokens)
        assert.equal(list.length, 1)
        assert.equal(list[0]!.tokenRef, issued.tokenRef)
        assert.equal(list[0]!.revoked, false)
        assert.equal(JSON.stringify(list).includes(issued.token), false)
        assert.equal(fx.Audit.Serialized().includes(issued.token), false)
        await fx.Client.sendRequest(AdminProtocol.RevokeToken, { tokenRef: issued.tokenRef })
        assert.equal((await fx.Client.sendRequest(AdminProtocol.ListTokens))[0]!.revoked, true)
        await assert.rejects(fx.Client.sendRequest(AdminProtocol.RevokeToken, { tokenRef: 'unknown-ref' }), (e: unknown) =>
            e instanceof ResponseError && e.code === ErrorCodes.InvalidRequest)
    }
    finally
    {
        fx.Dispose()
    }
})

test('a huge expiresInSeconds is InvalidParams and issues no token', async () =>
{
    const fx = new AdminFixture(Role.Owner)
    try
    {
        await AccountTokenCases.Invalid(fx.Client.sendRequest(AdminProtocol.IssueToken, { principalId: 'carol', scopes: [], expiresInSeconds: Number.MAX_SAFE_INTEGER }), 'expiresInSeconds')
        assert.deepEqual(await fx.Client.sendRequest(AdminProtocol.ListTokens), [])
    }
    finally
    {
        fx.Dispose()
    }
})

test('a non-duplicate store fault on create is not InvalidRequest and is not mapped to a client error', async () =>
{
    const fx = new AdminFixture(Role.Owner)
    try
    {
        await assert.rejects(fx.Client.sendRequest(AdminProtocol.CreateAccount, { email: FaultingAccountStore.FaultEmail, principalId: 'fault', password: AccountTokenCases.Password }), (e: unknown) =>
            e instanceof ResponseError && e.code !== ErrorCodes.InvalidRequest)
        await AccountTokenCases.Create(fx)
        await assert.rejects(AccountTokenCases.Create(fx), (e: unknown) =>
            e instanceof ResponseError && e.code === ErrorCodes.InvalidRequest && e.message === 'account already exists')
    }
    finally
    {
        fx.Dispose()
    }
})

test('missing params and non-string fields are InvalidParams naming the field', async () =>
{
    const fx = new AdminFixture(Role.Owner)
    try
    {
        await AccountTokenCases.Invalid(fx.Client.sendRequest(AdminProtocol.DisableAccount, undefined as never), 'principalId')
        await AccountTokenCases.Invalid(fx.Client.sendRequest(AdminProtocol.DisableAccount, {} as never), 'principalId')
        await AccountTokenCases.Invalid(fx.Client.sendRequest(AdminProtocol.RevokeToken, undefined as never), 'tokenRef')
        await AccountTokenCases.Invalid(fx.Client.sendRequest(AdminProtocol.RevokeToken, {} as never), 'tokenRef')
        await AccountTokenCases.Invalid(fx.Client.sendRequest(AdminProtocol.RevokeToken, { tokenRef: 7 } as never), 'tokenRef')
        await AccountTokenCases.Invalid(fx.Client.sendRequest(AdminProtocol.InvalidatePack, {} as never), 'name')
        await AccountTokenCases.Invalid(fx.Client.sendRequest(AdminProtocol.InvalidatePack, { name: '' } as never), 'name')
        await AccountTokenCases.Invalid(fx.Client.sendRequest(AdminProtocol.InvalidatePack, { name: '   ' } as never), 'name')
        assert.deepEqual(fx.InvalidatedPacks, [])
        for (const method of [AdminProtocol.AllowPackScripts, AdminProtocol.DenyPackScripts])
        {
            await AccountTokenCases.Invalid(fx.Client.sendRequest(method, {} as never), 'name')
            await AccountTokenCases.Invalid(fx.Client.sendRequest(method, { name: '' } as never), 'name')
            await AccountTokenCases.Invalid(fx.Client.sendRequest(method, { name: '   ' } as never), 'name')
        }
        assert.deepEqual(fx.AllowedPacks, [])
        assert.deepEqual(fx.DeniedPacks, [])
        await AccountTokenCases.Invalid(fx.Client.sendRequest(AdminProtocol.CreateAccount, { email: 5, principalId: 'a', password: AccountTokenCases.Password } as never), 'email')
    }
    finally
    {
        fx.Dispose()
    }
})

test('a Viewer is rejected on every pack method and no pack callback runs', async () =>
{
    const fx = new AdminFixture(Role.Viewer)
    try
    {
        const calls: Promise<unknown>[] = [
            fx.Client.sendRequest(AdminProtocol.InvalidatePack, { name: 'acme-pack' }),
            fx.Client.sendRequest(AdminProtocol.ListScriptAllowlist),
            fx.Client.sendRequest(AdminProtocol.AllowPackScripts, { name: 'acme-pack' }),
            fx.Client.sendRequest(AdminProtocol.DenyPackScripts, { name: 'acme-pack' }),
        ]
        for (const call of calls)
        {
            await assert.rejects(call, (e: unknown) => e instanceof ResponseError && e.code === ErrorCodes.InvalidRequest)
        }
        assert.deepEqual(fx.InvalidatedPacks, [])
        assert.deepEqual(fx.AllowedPacks, [])
        assert.deepEqual(fx.DeniedPacks, [])
    }
    finally
    {
        fx.Dispose()
    }
})

test('pack admin ops surface a clean error when no pack provider is configured', async () =>
{
    const fx = new AdminFixture(Role.Owner, true)
    try
    {
        const calls: Promise<unknown>[] = [
            fx.Client.sendRequest(AdminProtocol.InvalidatePack, { name: 'acme-pack' }),
            fx.Client.sendRequest(AdminProtocol.ListScriptAllowlist),
            fx.Client.sendRequest(AdminProtocol.AllowPackScripts, { name: 'acme-pack' }),
            fx.Client.sendRequest(AdminProtocol.DenyPackScripts, { name: 'acme-pack' }),
        ]
        for (const call of calls)
        {
            await assert.rejects(call, (e: unknown) => e instanceof ResponseError && e.code === ErrorCodes.InvalidRequest && /no adapter pack provider is configured/.test(e.message))
        }
        // The mutation failed closed, so nothing was audited as having happened.
        assert.equal(fx.Audit.Events.length, 0)
    }
    finally
    {
        fx.Dispose()
    }
})

test('a valid pack name reaches the invalidatePack callback', async () =>
{
    const fx = new AdminFixture(Role.Owner)
    try
    {
        const ack = await fx.Client.sendRequest(AdminProtocol.InvalidatePack, { name: 'acme-pack' })
        assert.deepEqual(ack, { ok: true })
        assert.deepEqual(fx.InvalidatedPacks, ['acme-pack'])
    }
    finally
    {
        fx.Dispose()
    }
})

test('valid pack names reach the allow and deny callbacks and list returns names', async () =>
{
    const fx = new AdminFixture(Role.Owner)
    try
    {
        assert.deepEqual(await fx.Client.sendRequest(AdminProtocol.AllowPackScripts, { name: 'acme-pack' }), { ok: true })
        assert.deepEqual(await fx.Client.sendRequest(AdminProtocol.DenyPackScripts, { name: 'other-pack' }), { ok: true })
        assert.deepEqual(fx.AllowedPacks, ['acme-pack'])
        assert.deepEqual(fx.DeniedPacks, ['other-pack'])
        assert.deepEqual(await fx.Client.sendRequest(AdminProtocol.ListScriptAllowlist), { names: ['seed-pack', 'acme-pack'] })
    }
    finally
    {
        fx.Dispose()
    }
})

test('a valid expiresInSeconds is honored as roughly now plus N', async () =>
{
    const fx = new AdminFixture(Role.Owner)
    try
    {
        const before = Date.now()
        const issued = await fx.Client.sendRequest(AdminProtocol.IssueToken, { principalId: 'carol', scopes: [], expiresInSeconds: 3600 })
        const expiry = new Date(issued.expiresAt as string).getTime()
        assert.ok(Math.abs(expiry - (before + 3600 * 1000)) < 10000)
    }
    finally
    {
        fx.Dispose()
    }
})

test('entirely missing params on create and issue are InvalidParams naming a specific field', async () =>
{
    const fx = new AdminFixture(Role.Owner)
    try
    {
        await AccountTokenCases.Invalid(fx.Client.sendRequest(AdminProtocol.CreateAccount, undefined as never), 'email')
        await AccountTokenCases.Invalid(fx.Client.sendRequest(AdminProtocol.IssueToken, undefined as never), 'principalId')
        assert.equal(await AccountTokenCases.AccountCount(fx), 0)
    }
    finally
    {
        fx.Dispose()
    }
})
