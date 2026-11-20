import { LiveUpdateBridge } from '@pragmatic-tech-ai/pragmatic-app-shell'
import type { NavigationService } from '@pragmatic-tech-ai/mural/framework/shell/services/navigation-service.js'
import { PortalSectionService } from './portal-section-service.js'

// Turns a control-plane change notification (it carries no payload) into a refresh of what the operator is looking
// at: the active rail section's current page only. The section keeps its page stack, so a detail page stays a detail
// page.
export class PortalLiveUpdateBridge extends LiveUpdateBridge<void, PortalSectionService>
{
    public constructor(nav: NavigationService)
    {
        super(nav)
    }

    protected IsSection(service: unknown): service is PortalSectionService
    {
        return service instanceof PortalSectionService
    }

    protected async Deliver(section: PortalSectionService): Promise<void>
    {
        await section.RefreshCurrent()
    }
}
