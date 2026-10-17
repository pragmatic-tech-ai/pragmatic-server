import { Action, AuditEvent, AuditEventKind, Grant, ResourceRef, Role, RoleCapabilities, ResourceKind } from '@pragmatic-tech-ai/todl-identity'
import type { LocalAccount, ServiceTokenSummary, PresentedSecret, IRoleGrantStore, IAuditSink, ITenantConfigStore, ILocalAccountStore, IServiceTokenStore, ServiceTokenGrant, Tenant, IdentityConfig } from '@pragmatic-tech-ai/todl-identity'
import type { LocalAccountRegistrar } from '@pragmatic-tech-ai/todl-identity-local'
import { AdminEnums } from './admin-enums.js'
import type { IAdapterPackAdmin } from './adapter-pack-admin.js'

/** Raised when a caller tries to revoke their own tenant-Owner grant. */
export class AdminSelfLockoutError extends Error
{
    public constructor()
    {
        super('cannot revoke your own tenant-Owner grant')
        this.name = 'AdminSelfLockoutError'
    }
}

/** Raised when revoking a grant would leave the tenant with no administrator. */
export class LastAdministratorError extends Error
{
    public constructor()
    {
        super('cannot revoke the tenant\'s last administrator')
        this.name = 'LastAdministratorError'
    }
}

/** Raised when a service token reference is unknown to this tenant. */
export class AdminTokenNotFoundError extends Error
{
    public constructor(public readonly TokenRef: string)
    {
        super('service token not found')
        this.name = 'AdminTokenNotFoundError'
    }
}

/** Raised when the tenant has no stored identity config. */
export class AdminConfigMissingError extends Error
{
    public constructor()
    {
        super('tenant identity config is missing')
        this.name = 'AdminConfigMissingError'
    }
}

/** RBAC-gated admin operations over the tenant's grant store, config store and audit sink.
 *  Every mutation is audited (awaited, fail-closed) with identifiers only, never secrets. */
export class AdminService
{
    private static readonly ActorKey = 'actor'
    private static readonly ActionKey = 'action'
    private static readonly RoleKey = 'role'
    private static readonly ResourceKindKey = 'resourceKind'
    private static readonly ResourcePathKey = 'resourcePath'
    private static readonly PathSeparator = '/'
    private static readonly PackIdKey = 'packId'
    private static readonly DelegationDepthKey = 'delegationDepth'
    private static readonly GrantRoleAction = 'grant-role'
    private static readonly RevokeRoleAction = 'revoke-role'
    private static readonly SetConfigAction = 'set-config'
    private static readonly CreateAccountAction = 'create-account'
    private static readonly DisableAccountAction = 'disable-account'
    private static readonly IssueTokenAction = 'issue-token'
    private static readonly RevokeTokenAction = 'revoke-token'
    private static readonly InvalidatePackAction = 'invalidate-pack'
    private static readonly AllowPackScriptsAction = 'allow-pack-scripts'
    private static readonly DenyPackScriptsAction = 'deny-pack-scripts'
    private static readonly PackNameKey = 'pack'
    private static readonly PrincipalIdKey = 'principalId'
    private static readonly EmailKey = 'email'
    private static readonly TokenRefKey = 'tokenRef'
    private static readonly ScopesKey = 'scopes'
    private static readonly ScopeSeparator = ' '

    private readonly grants: IRoleGrantStore
    private readonly audit: IAuditSink
    private readonly configStore: ITenantConfigStore
    private readonly tenant: Tenant
    private readonly evict: () => Promise<void>
    private readonly accounts: ILocalAccountStore
    private readonly registrar: LocalAccountRegistrar
    private readonly tokens: IServiceTokenStore
    private readonly packs: IAdapterPackAdmin

    public constructor(grants: IRoleGrantStore, audit: IAuditSink, configStore: ITenantConfigStore, tenant: Tenant, evict: () => Promise<void>, accounts: ILocalAccountStore, registrar: LocalAccountRegistrar, tokens: IServiceTokenStore, packs: IAdapterPackAdmin)
    {
        this.packs = packs
        this.grants = grants
        this.audit = audit
        this.configStore = configStore
        this.tenant = tenant
        this.evict = evict
        this.accounts = accounts
        this.registrar = registrar
        this.tokens = tokens
    }

    public async ListGrants(subject: string): Promise<readonly Grant[]>
    {
        const grants = await this.grants.GrantsFor(subject, this.tenant)
        return grants.filter(grant => grant.Resource.TenantId === this.tenant.Id)
    }

    public async GrantRole(actor: string, subject: string, role: Role, resource: ResourceRef): Promise<void>
    {
        await this.grants.Save(new Grant(subject, role, resource))
        await this.Audit(subject, AdminService.GrantDetail(actor, AdminService.GrantRoleAction, role, resource))
    }

    public async RevokeRole(actor: string, subject: string, role: Role, resource: ResourceRef): Promise<void>
    {
        if (subject === actor && role === Role.Owner && resource.Kind === ResourceKind.Tenant && resource.Path.length === 0)
        {
            throw new AdminSelfLockoutError()
        }
        if (resource.Kind === ResourceKind.Tenant && resource.Path.length === 0 && RoleCapabilities.Covers(role, Action.Administer))
        {
            const onRoot = await this.grants.GrantsOn(new ResourceRef(ResourceKind.Tenant, resource.TenantId, []))
            const remaining = onRoot.filter(grant => RoleCapabilities.Covers(grant.Role, Action.Administer) && !(grant.Subject === subject && grant.Role === role))
            if (remaining.length === 0)
            {
                throw new LastAdministratorError()
            }
        }
        await this.grants.Revoke(new Grant(subject, role, resource))
        await this.Audit(subject, AdminService.GrantDetail(actor, AdminService.RevokeRoleAction, role, resource))
    }

    public async GetConfig(): Promise<IdentityConfig>
    {
        const config = await this.configStore.Get(this.tenant.Id)
        if (config === null)
        {
            throw new AdminConfigMissingError()
        }
        return config
    }

    public async SetConfig(actor: string, config: IdentityConfig): Promise<void>
    {
        await this.configStore.Save(this.tenant.Id, config)
        const detail = new Map<string, string>([
            [AdminService.ActorKey, actor],
            [AdminService.ActionKey, AdminService.SetConfigAction],
            [AdminService.PackIdKey, config.PackId],
            [AdminService.DelegationDepthKey, AdminEnums.NameOfDepth(config.DelegationDepth)],
        ])
        await this.Audit(null, detail)
        await this.evict()
    }

    public async ListAccounts(): Promise<readonly LocalAccount[]>
    {
        return this.accounts.ListAccounts(this.tenant)
    }

    public async CreateAccount(actor: string, email: string, principalId: string, password: PresentedSecret): Promise<LocalAccount>
    {
        const account = await this.registrar.Register(this.tenant, email, principalId, password)
        const detail = new Map<string, string>([
            [AdminService.ActorKey, actor],
            [AdminService.ActionKey, AdminService.CreateAccountAction],
            [AdminService.PrincipalIdKey, principalId],
            [AdminService.EmailKey, email],
        ])
        await this.Audit(principalId, detail)
        return account
    }

    public async DisableAccount(actor: string, principalId: string): Promise<void>
    {
        await this.accounts.Disable(this.tenant, principalId)
        const detail = new Map<string, string>([
            [AdminService.ActorKey, actor],
            [AdminService.ActionKey, AdminService.DisableAccountAction],
            [AdminService.PrincipalIdKey, principalId],
        ])
        await this.Audit(principalId, detail)
    }

    public async ListTokens(): Promise<readonly ServiceTokenSummary[]>
    {
        return this.tokens.List(this.tenant)
    }

    public async IssueToken(actor: string, principalId: string, scopes: readonly string[], expiresAt: Date | null): Promise<{ Grant: ServiceTokenGrant, Token: string }>
    {
        const issued = await this.tokens.Issue(this.tenant, principalId, scopes, expiresAt)
        const detail = new Map<string, string>([
            [AdminService.ActorKey, actor],
            [AdminService.ActionKey, AdminService.IssueTokenAction],
            [AdminService.PrincipalIdKey, principalId],
            [AdminService.TokenRefKey, issued.Grant.TokenRef],
            [AdminService.ScopesKey, scopes.join(AdminService.ScopeSeparator)],
        ])
        await this.Audit(principalId, detail)
        return issued
    }

    public async RevokeToken(actor: string, tokenRef: string): Promise<void>
    {
        const existing = await this.tokens.List(this.tenant)
        if (!existing.some(summary => summary.TokenRef === tokenRef))
        {
            throw new AdminTokenNotFoundError(tokenRef)
        }
        await this.tokens.Revoke(this.tenant, tokenRef)
        const detail = new Map<string, string>([
            [AdminService.ActorKey, actor],
            [AdminService.ActionKey, AdminService.RevokeTokenAction],
            [AdminService.TokenRefKey, tokenRef],
        ])
        await this.Audit(null, detail)
    }

    public async InvalidatePack(actor: string, name: string): Promise<void>
    {
        await this.packs.Invalidate(name)
        const detail = new Map<string, string>([
            [AdminService.ActorKey, actor],
            [AdminService.ActionKey, AdminService.InvalidatePackAction],
            [AdminService.PackNameKey, name],
        ])
        await this.Audit(null, detail)
    }

    public async AllowPackScripts(actor: string, name: string): Promise<void>
    {
        await this.packs.AllowScripts(name)
        const detail = new Map<string, string>([
            [AdminService.ActorKey, actor],
            [AdminService.ActionKey, AdminService.AllowPackScriptsAction],
            [AdminService.PackNameKey, name],
        ])
        await this.Audit(null, detail)
    }

    public async DenyPackScripts(actor: string, name: string): Promise<void>
    {
        await this.packs.DenyScripts(name)
        const detail = new Map<string, string>([
            [AdminService.ActorKey, actor],
            [AdminService.ActionKey, AdminService.DenyPackScriptsAction],
            [AdminService.PackNameKey, name],
        ])
        await this.Audit(null, detail)
    }

    public async ListScriptAllowlist(): Promise<readonly string[]>
    {
        return this.packs.ListScriptAllowlist()
    }

    private async Audit(subject: string | null, detail: ReadonlyMap<string, string>): Promise<void>
    {
        await this.audit.Record(new AuditEvent(AuditEventKind.AdminAction, this.tenant.Id, subject, new Date(), detail))
    }

    private static GrantDetail(actor: string, action: string, role: Role, resource: ResourceRef): ReadonlyMap<string, string>
    {
        return new Map<string, string>([
            [AdminService.ActorKey, actor],
            [AdminService.ActionKey, action],
            [AdminService.RoleKey, AdminEnums.NameOfRole(role)],
            [AdminService.ResourceKindKey, AdminEnums.NameOfResourceKind(resource.Kind)],
            [AdminService.ResourcePathKey, resource.Path.join(AdminService.PathSeparator)],
        ])
    }
}
