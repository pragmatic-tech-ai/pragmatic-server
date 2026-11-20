import { LiveUpdateBridge } from '@pragmatic-tech-ai/pragmatic-app-shell'
import type { NavigationService } from '@pragmatic-tech-ai/mural/framework/shell/services/navigation-service.js'
import type { TenantEvent } from '../tenant-types.js'
import { TenantSectionService } from './tenant-section-service.js'
import type { TenantSessionService } from './tenant-session-service.js'

// Turns a tenant event into what the operator sees: it is recorded in the session's activity log, then the active
// rail section handles it (by default it reloads its current page; a detail page stays a detail page).
export class TenantLiveUpdateBridge extends LiveUpdateBridge<TenantEvent, TenantSectionService>
{
    public constructor(nav: NavigationService, private readonly session: TenantSessionService)
    {
        super(nav)
    }

    public override async OnEvent(event: TenantEvent): Promise<void>
    {
        this.session.RecordEvent(event)
        await super.OnEvent(event)
    }

    // Rebuilds the active section from a fresh root page, which starts its own load (after the session starts).
    public RestartActive(): void
    {
        this.ActiveSection()?.Restart()
    }

    protected IsSection(service: unknown): service is TenantSectionService
    {
        return service instanceof TenantSectionService
    }

    protected async Deliver(section: TenantSectionService, event: TenantEvent): Promise<void>
    {
        await section.OnTenantEvent(event)
    }
}
