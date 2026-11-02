import { AdminCapability } from '../../../shell/admin-capability.js'
import type { TenantSessionService } from '../../../shell/tenant-session-service.js'
import { EnvironmentScopedPageViewModel } from '../environment-scoped-page-view-model.js'
import type { UsersAccessSectionService } from '../users-access-section-service.js'

// SKELETON (Task 6 replaces it): the Roles & permissions tab, the security
// model editor for the selected environment. Implements IHoldsPendingWork
// (registered with PendingWork) once it holds unsaved changes.
export class SecurityModelEditorViewModel extends EnvironmentScopedPageViewModel
{
    public constructor(session: TenantSessionService, protected readonly section: UsersAccessSectionService)
    {
        super(session)
    }

    protected override get PageCapability(): AdminCapability | undefined
    {
        return AdminCapability.Access
    }

    protected override async LoadFor(_environment: string): Promise<boolean>
    {
        return false
    }
}
