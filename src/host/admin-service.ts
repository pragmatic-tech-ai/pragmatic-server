import { AuditEvent, AuditEventKind, Grant, Role, ResourceKind } from '@pragmatic-tech-ai/todl-identity'
import type { IRoleGrantStore, IAuditSink, ITenantConfigStore, Tenant, ResourceRef, IdentityConfig } from '@pragmatic-tech-ai/todl-identity'
import { AdminEnums } from './admin-enums.js'

/** Raised when a caller tries to revoke their own tenant-Owner grant. */
export class AdminSelfLockoutError extends Error
{
    public constructor()
    {
        super('cannot revoke your own tenant-Owner grant')
        this.name = 'AdminSelfLockoutError'
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

    private readonly grants: IRoleGrantStore
    private readonly audit: IAuditSink
    private readonly configStore: ITenantConfigStore
    private readonly tenant: Tenant
    private readonly evict: () => Promise<void>

    public constructor(grants: IRoleGrantStore, audit: IAuditSink, configStore: ITenantConfigStore, tenant: Tenant, evict: () => Promise<void>)
    {
        this.grants = grants
        this.audit = audit
        this.configStore = configStore
        this.tenant = tenant
        this.evict = evict
    }

    public async ListGrants(subject: string): Promise<readonly Grant[]>
    {
        return this.grants.GrantsFor(subject, this.tenant)
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
        await this.evict()
        const detail = new Map<string, string>([
            [AdminService.ActorKey, actor],
            [AdminService.ActionKey, AdminService.SetConfigAction],
            [AdminService.PackIdKey, config.PackId],
            [AdminService.DelegationDepthKey, AdminEnums.NameOfDepth(config.DelegationDepth)],
        ])
        await this.Audit(null, detail)
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
