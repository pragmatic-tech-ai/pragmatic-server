import { OneTimeSecretPageViewModel } from '../../shell/one-time-secret-page-view-model.js'
import type { TenantsSectionService } from './tenants-section-service.js'

// The new tenant's Owner password, shown once (see OneTimeSecretPageViewModel).
// Confirming clears it and moves on to the tenant's detail.
export class OwnerPasswordRevealPageViewModel extends OneTimeSecretPageViewModel
{
    public constructor(private readonly section: TenantsSectionService, public readonly TenantId: string, public readonly Email: string, value: string)
    {
        super(section, value)
    }

    protected override OnSaved(): void
    {
        this.section.ShowTenantAfterReveal(this.TenantId)
    }
}
