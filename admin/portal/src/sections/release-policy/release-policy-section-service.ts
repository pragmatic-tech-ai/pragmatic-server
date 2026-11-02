import { ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { PortalSectionService } from '../../shell/portal-section-service.js'
import type { PortalPageViewModel } from '../../shell/portal-page-view-model.js'
import { HivesSectionService } from '../hives/hives-section-service.js'
import { ReleasePolicyPageViewModel } from './release-policy-page-view-model.js'

// The Release Policy rail section: one page with the policy rules, the gated
// versions and the adoption ledger. A ledger entry's hive opens in Hives.
export class ReleasePolicySectionService extends PortalSectionService
{
    public static readonly Key = new ServiceKey<ReleasePolicySectionService>('ReleasePolicySectionService')

    public constructor(provider: IServiceProvider)
    {
        super(provider)
    }

    public OpenHive(id: string): void
    {
        this.Provider.get(HivesSectionService.Key)?.ShowHive(id)
    }

    protected override CreateRoot(): PortalPageViewModel
    {
        return new ReleasePolicyPageViewModel(this.Session, this)
    }
}
