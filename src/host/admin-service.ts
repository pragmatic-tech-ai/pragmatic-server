import { Action, AuditEvent, AuditEventKind, Grant, ResourceRef, Role, RoleCapabilities, ResourceKind, IdentityConfig, SecurityModelValidator } from '@pragmatic-tech-ai/todl-identity'
import type { SecurityChangesDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { LocalAccount, ServiceTokenSummary, PresentedSecret, IRoleGrantStore, IAuditSink, ITenantConfigStore, ILocalAccountStore, IServiceTokenStore, ServiceTokenGrant, Tenant, ISecurityModelConfig, ISessionManager, TeamMembershipRow } from '@pragmatic-tech-ai/todl-identity'
import type { IEnvironmentCatalog } from '@pragmatic-tech-ai/todl/engine'
import type { LocalAccountRegistrar } from '@pragmatic-tech-ai/todl-identity-local'
import { AdminEnums } from './admin-enums.js'
import type { IAdapterPackAdmin } from './adapter-pack-admin.js'
import type { SecuritySettingIssue } from './environment/security-setting-catalog-check.js'
import type { IPrincipalInvalidator } from './principal-connection-registry.js'

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

/** Raised when the tenant takes no security setting: a Development tenant (program ruling PR13). */
export class AdminSecurityModelUnavailableError extends Error
{
    private static readonly Message = 'a development tenant has no security setting; its access is the tenant role grants'

    public constructor()
    {
        super(AdminSecurityModelUnavailableError.Message)
        this.name = 'AdminSecurityModelUnavailableError'
    }
}

/** Raised when a security setting names something the deployed packages cannot mean; the first issue is the reason. */
export class AdminSecuritySettingRefusedError extends Error
{
    public constructor(public readonly Issues: readonly SecuritySettingIssue[])
    {
        super(Issues[0].Message)
        this.name = 'AdminSecuritySettingRefusedError'
    }
}

/** What the admin save and reads need of a Runtime environment's security (EnvironmentSecurityAdmin); absent on a Development tenant. */
export interface ISecuritySettingAdmin
{
    /** The catalog issues of `config` against the deployed packages; throws InvalidSecurityModelError when it is structurally invalid. */
    Issues(config: ISecurityModelConfig): Promise<readonly SecuritySettingIssue[]>
    /**
     * Runs `write` (a store of the tenant config) under the setting's write lock, after re-checking `config` (when
     * given) against the catalog the setting was last reconciled to; the issues found, `write` not run when any.
     */
    Locked(config: ISecurityModelConfig | undefined, write: () => Promise<void>): Promise<readonly SecuritySettingIssue[]>
    /** Drops the cached setting, so every scope compiled after it reads the stored one. */
    Invalidate(): void
    /** The environment's security catalog: the vocabulary the admin edits the setting against (S4 Task 10). */
    Catalog(): Promise<IEnvironmentCatalog>
    /** The team's effective membership rows (synced + manual, inactive filtered); throws UnknownTeamError for an unknown team. */
    TeamMembers(teamId: string): Promise<readonly TeamMembershipRow[]>
    /** The security changes of the environment's deploys and promotes, newest first (S4 Task 13). */
    SecurityChanges(): Promise<SecurityChangesDto[]>
    /** Requests an IdP directory sync now (fire-and-forget); the host serializes and coalesces runs. */
    RequestSync(): void
}

/** Raised when a team-members read names a team the stored setting does not define. */
export class UnknownTeamError extends Error
{
    public static readonly Message = 'unknown team'

    public constructor(public readonly TeamId: string)
    {
        super(UnknownTeamError.Message)
        this.name = 'UnknownTeamError'
    }
}

/** Raised when a grant mutation targets a resource that belongs to a different tenant. */
export class ForeignTenantResourceError extends Error
{
    private static readonly Message = 'resource does not belong to this tenant'

    public constructor()
    {
        super(ForeignTenantResourceError.Message)
        this.name = 'ForeignTenantResourceError'
    }
}

/** RBAC-gated admin operations over the tenant's grant store, config store and audit sink.
 *  Every mutation is audited (awaited, fail-closed) with identifiers only, never secrets. */
export class AdminService
{
    /** Process-shared per-tenant lock chain: every AdminService instance (one per connection) serializes through it. */
    private static readonly Locks = new Map<string, Promise<unknown>>()
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
    private static readonly SetSecurityModelAction = 'set-security-model'
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
    private readonly security: ISecuritySettingAdmin | undefined
    private readonly invalidator?: IPrincipalInvalidator
    private readonly sessions?: ISessionManager

    public constructor(grants: IRoleGrantStore, audit: IAuditSink, configStore: ITenantConfigStore, tenant: Tenant, evict: () => Promise<void>, accounts: ILocalAccountStore, registrar: LocalAccountRegistrar, tokens: IServiceTokenStore, packs: IAdapterPackAdmin, security: ISecuritySettingAdmin | undefined, invalidator?: IPrincipalInvalidator, sessions?: ISessionManager)
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
        this.security = security
        this.invalidator = invalidator
        this.sessions = sessions
    }

    public async ListGrants(subject: string): Promise<readonly Grant[]>
    {
        const grants = await this.grants.GrantsFor(subject, this.tenant)
        return grants.filter(grant => grant.Resource.TenantId === this.tenant.Id)
    }

    public async GrantRole(actor: string, subject: string, role: Role, resource: ResourceRef): Promise<void>
    {
        this.AssertOwnTenant(resource)
        await this.Serialized(this.tenant.Id, async () =>
        {
            await this.grants.Save(new Grant(subject, role, resource))
            await this.Audit(subject, AdminService.GrantDetail(actor, AdminService.GrantRoleAction, role, resource))
        })
    }

    public async RevokeRole(actor: string, subject: string, role: Role, resource: ResourceRef): Promise<void>
    {
        this.AssertOwnTenant(resource)
        await this.Serialized(this.tenant.Id, async () =>
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
        })
        this.invalidator?.InvalidatePrincipal(this.tenant.Id, subject)
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

    /** Replaces the whole config; a carried security setting is checked as SetSecurityModel checks it. */
    public async SetConfig(actor: string, config: IdentityConfig): Promise<void>
    {
        if (config.SecurityModel !== undefined)
        {
            await this.CheckSecurityModel(config.SecurityModel)
        }
        await this.Locked(config.SecurityModel, () => this.configStore.Save(this.tenant.Id, config))
        this.security?.Invalidate()
        const detail = new Map<string, string>([
            [AdminService.ActorKey, actor],
            [AdminService.ActionKey, AdminService.SetConfigAction],
            [AdminService.PackIdKey, config.PackId],
            [AdminService.DelegationDepthKey, AdminEnums.NameOfDepth(config.DelegationDepth)],
        ])
        await this.Audit(null, detail)
        await this.evict()
    }

    /** The tenant's current access SecurityModel, or undefined when no config or no model is stored. */
    public async GetSecurityModel(): Promise<ISecurityModelConfig | undefined>
    {
        const config = await this.configStore.Get(this.tenant.Id)
        return config?.SecurityModel
    }

    /** The environment's security catalog (the admin's editing vocabulary); refused on a Development tenant (PR13). */
    public async GetSecurityCatalog(): Promise<IEnvironmentCatalog>
    {
        if (this.security === undefined)
        {
            throw new AdminSecurityModelUnavailableError()
        }
        return this.security.Catalog()
    }

    /** The environment's security change log, newest first; refused on a Development tenant (PR13). */
    public async ListSecurityChanges(): Promise<SecurityChangesDto[]>
    {
        if (this.security === undefined)
        {
            throw new AdminSecurityModelUnavailableError()
        }
        return this.security.SecurityChanges()
    }

    /** A team's effective membership rows; refused on a Development tenant (PR13); UnknownTeamError for an unknown team. */
    public async ListTeamMembers(teamId: string): Promise<readonly TeamMembershipRow[]>
    {
        if (this.security === undefined)
        {
            throw new AdminSecurityModelUnavailableError()
        }
        return this.security.TeamMembers(teamId)
    }

    /**
     * Replaces ONLY the tenant's security setting (every other config field is preserved), persists it, then invalidates
     * the cached setting so the change takes effect on the next scope without a restart. Refused before any write: on a
     * Development tenant (AdminSecurityModelUnavailableError, PR13), a structurally invalid setting
     * (InvalidSecurityModelError) and one the deployed packages cannot mean (AdminSecuritySettingRefusedError); the
     * tenant must already have a stored config.
     */
    public async SetSecurityModel(actor: string, model: ISecurityModelConfig): Promise<void>
    {
        await this.CheckSecurityModel(model)
        let stored: IdentityConfig | undefined
        await this.Locked(model, async () =>
        {
            const config = await this.configStore.Get(this.tenant.Id)
            if (config === null)
            {
                throw new AdminConfigMissingError()
            }
            stored = config
            await this.configStore.Save(this.tenant.Id, new IdentityConfig(config.PackId, config.DelegationDepth, config.ProviderSettings, config.GroupRoleMap, config.ClaimsMapping, model))
        })
        const detail = new Map<string, string>([
            [AdminService.ActorKey, actor],
            [AdminService.ActionKey, AdminService.SetSecurityModelAction],
            [AdminService.PackIdKey, stored!.PackId],
        ])
        await this.Audit(null, detail)
        this.security?.Invalidate()
        // Pull the directory for the groups and principals the new setting names (S4 Task 10); the run re-invalidates when it lands.
        this.security?.RequestSync()
    }

    /**
     * Stores through `write` under the security setting's write lock (S4 Task 13: a deploy's prune and an admin save
     * never interleave), re-checking `model` against the catalog a deploy reconciled the setting to meanwhile; without a
     * security setting (Development) `write` runs as is.
     */
    private async Locked(model: ISecurityModelConfig | undefined, write: () => Promise<void>): Promise<void>
    {
        if (this.security === undefined)
        {
            await write()
            return
        }
        const issues = await this.security.Locked(model, write)
        if (issues.length > 0)
        {
            throw new AdminSecuritySettingRefusedError(issues)
        }
    }

    private async CheckSecurityModel(model: ISecurityModelConfig): Promise<void>
    {
        if (this.security === undefined)
        {
            throw new AdminSecurityModelUnavailableError()
        }
        SecurityModelValidator.AssertValid(model)
        const issues = await this.security.Issues(model)
        if (issues.length > 0)
        {
            throw new AdminSecuritySettingRefusedError(issues)
        }
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
        await this.sessions?.RevokeAllFor(this.tenant, principalId)
        const detail = new Map<string, string>([
            [AdminService.ActorKey, actor],
            [AdminService.ActionKey, AdminService.DisableAccountAction],
            [AdminService.PrincipalIdKey, principalId],
        ])
        await this.Audit(principalId, detail)
        this.invalidator?.InvalidatePrincipal(this.tenant.Id, principalId)
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
        const summary = existing.find(s => s.TokenRef === tokenRef)
        if (summary === undefined)
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
        this.invalidator?.InvalidatePrincipal(this.tenant.Id, summary.PrincipalId)
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

    private AssertOwnTenant(resource: ResourceRef): void
    {
        if (resource.TenantId !== this.tenant.Id)
        {
            throw new ForeignTenantResourceError()
        }
    }

    private async Serialized<T>(key: string, work: () => Promise<T>): Promise<T>
    {
        const previous = AdminService.Locks.get(key) ?? Promise.resolve()
        const run = previous.catch(() => undefined).then(work)
        AdminService.Locks.set(key, run)
        try
        {
            return await run
        }
        finally
        {
            if (AdminService.Locks.get(key) === run)
            {
                AdminService.Locks.delete(key)
            }
        }
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
