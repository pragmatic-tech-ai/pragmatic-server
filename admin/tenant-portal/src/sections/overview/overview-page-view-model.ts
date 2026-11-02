import { TenantPageViewModel } from '../../shell/tenant-page-view-model.js'
import type { TenantSessionService } from '../../shell/tenant-session-service.js'
import type { OverviewSectionService } from './overview-section-service.js'

// SKELETON (Task 3 replaces it): the Overview home page.
export class OverviewPageViewModel extends TenantPageViewModel
{
    public constructor(session: TenantSessionService, private readonly section: OverviewSectionService)
    {
        super(session)
    }

    public get OpenActivityCommand(): unknown
    {
        return this.section.OpenActivityCommand
    }

    protected override async LoadCore(): Promise<boolean>
    {
        return false
    }
}
