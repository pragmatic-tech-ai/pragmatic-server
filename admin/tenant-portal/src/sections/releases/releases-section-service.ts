import { ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { TenantSectionService } from '../../shell/tenant-section-service.js'
import type { TenantPageViewModel } from '../../shell/tenant-page-view-model.js'
import { ReleasesPageViewModel } from './releases-page-view-model.js'

// The Releases rail section.
export class ReleasesSectionService extends TenantSectionService
{
    public static readonly Key = new ServiceKey<ReleasesSectionService>('ReleasesSectionService')

    public constructor(provider: IServiceProvider)
    {
        super(provider)
    }

    protected override CreateRoot(): TenantPageViewModel
    {
        return new ReleasesPageViewModel(this.Session)
    }
}
