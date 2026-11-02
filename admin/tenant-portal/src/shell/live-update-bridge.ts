import type { NavigationService } from '@pragmatic-tech-ai/mural/framework/shell/services/navigation-service.js'
import type { TenantEvent } from '../tenant-types.js'
import { TenantSectionService } from './tenant-section-service.js'
import type { TenantSessionService } from './tenant-session-service.js'

// Turns a tenant event into what the operator sees: it is recorded in the
// session's activity log, then the active rail section handles it (by default
// it reloads its current page; a detail page stays a detail page).
export class LiveUpdateBridge
{
    public constructor(private readonly nav: NavigationService, private readonly session: TenantSessionService)
    {
    }

    public async OnEvent(ev: TenantEvent): Promise<void>
    {
        this.session.RecordEvent(ev)
        const active = this.nav.ActiveService
        if (active instanceof TenantSectionService)
        {
            await active.OnTenantEvent(ev)
        }
    }

    // Reloads the active section's current page (after the session starts).
    public async RefreshActive(): Promise<void>
    {
        const active = this.nav.ActiveService
        if (active instanceof TenantSectionService)
        {
            await active.RefreshCurrent()
        }
    }
}
