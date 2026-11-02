import { TenantPageViewModel } from '../../shell/tenant-page-view-model.js'
import type { TenantSessionService } from '../../shell/tenant-session-service.js'

// SKELETON (Task 3 replaces it): the Environments root page.
export class EnvironmentsPageViewModel extends TenantPageViewModel
{
    public constructor(session: TenantSessionService)
    {
        super(session)
    }

    protected override async LoadCore(): Promise<boolean>
    {
        return false
    }
}
