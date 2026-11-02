import { TenantPageViewModel } from '../../shell/tenant-page-view-model.js'
import type { TenantSessionService } from '../../shell/tenant-session-service.js'

// SKELETON (Task 4 replaces it): the Settings root page.
export class SettingsPageViewModel extends TenantPageViewModel
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
