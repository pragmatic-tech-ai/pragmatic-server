import { ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import type { CreatedTenantDto } from '../../portal-types.js'
import { PortalSectionService } from '../../shell/portal-section-service.js'
import type { PortalPageViewModel } from '../../shell/portal-page-view-model.js'
import { HivesSectionService } from '../hives/hives-section-service.js'
import { OwnerPasswordKind, OwnerPasswordRevealPageViewModel } from './owner-password-reveal-page-view-model.js'
import { TenantDetailPageViewModel } from './tenant-detail-page-view-model.js'
import { TenantsPageViewModel } from './tenants-page-view-model.js'

// The Tenants rail section: the tenants list, a tenant's detail, and the
// one-time Owner password reveal that follows creating a tenant.
export class TenantsSectionService extends PortalSectionService
{
    public static readonly Key = new ServiceKey<TenantsSectionService>('TenantsSectionService')

    public constructor(provider: IServiceProvider)
    {
        super(provider)
    }

    public OpenTenant(id: string): void
    {
        this.Present(new TenantDetailPageViewModel(this.Session, this, id))
    }

    // Shows a just-created tenant's Owner password once. The created DTO is
    // not kept; only the reveal page holds the value.
    public RevealOwnerPassword(created: CreatedTenantDto): void
    {
        this.Present(new OwnerPasswordRevealPageViewModel(this, created.id, created.owner.email, created.owner.password))
    }

    // Shows a reset Owner password once, over the tenant's detail (Back to the
    // detail once saved).
    public RevealResetOwnerPassword(tenantId: string, email: string, password: string, warning?: string): void
    {
        this.Present(new OwnerPasswordRevealPageViewModel(this, tenantId, email, password, OwnerPasswordKind.Reset, warning))
    }

    // After the reveal is confirmed: its page gives way to the tenant's detail
    // (Back then returns to the list, not to the cleared reveal).
    public ShowTenantAfterReveal(id: string): void
    {
        this.Replace(new TenantDetailPageViewModel(this.Session, this, id))
    }

    // Opens a hive's detail in the Hives section and brings that section to
    // the front.
    public OpenHive(hiveId: string): void
    {
        this.Provider.get(HivesSectionService.Key)?.ShowHive(hiveId)
    }

    protected override CreateRoot(): PortalPageViewModel
    {
        return new TenantsPageViewModel(this.Session, this)
    }
}
