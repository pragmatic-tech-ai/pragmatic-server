import { ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { TenantSectionService } from '../../shell/tenant-section-service.js'
import type { TenantPageViewModel } from '../../shell/tenant-page-view-model.js'
import { EnvironmentsPageViewModel } from './environments-page-view-model.js'

// The Environments rail section.
export class EnvironmentsSectionService extends TenantSectionService
{
    public static readonly Key = new ServiceKey<EnvironmentsSectionService>('EnvironmentsSectionService')

    public constructor(provider: IServiceProvider)
    {
        super(provider)
    }

    protected override CreateRoot(): TenantPageViewModel
    {
        return new EnvironmentsPageViewModel(this.Session)
    }
}
