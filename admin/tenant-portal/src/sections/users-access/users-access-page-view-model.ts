import { TenantPageViewModel } from '../../shell/tenant-page-view-model.js'
import type { TenantSessionService } from '../../shell/tenant-session-service.js'

// SKELETON (Task 5 replaces it): the Users & Access root page.
export class UsersAccessPageViewModel extends TenantPageViewModel
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
