import { ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { PortalSectionService } from '../../shell/portal-section-service.js'
import type { PortalPageViewModel } from '../../shell/portal-page-view-model.js'
import { ReleaseDetailPageViewModel } from './release-detail-page-view-model.js'
import { ReleasesPageViewModel } from './releases-page-view-model.js'

// The Registry & Releases rail section: the published versions, then a
// version's detail.
export class ReleasesSectionService extends PortalSectionService
{
    public static readonly Key = new ServiceKey<ReleasesSectionService>('ReleasesSectionService')

    public constructor(provider: IServiceProvider)
    {
        super(provider)
    }

    public OpenRelease(version: string): void
    {
        this.Present(new ReleaseDetailPageViewModel(this.Session, this, version))
    }

    protected override CreateRoot(): PortalPageViewModel
    {
        return new ReleasesPageViewModel(this.Session, this)
    }
}
