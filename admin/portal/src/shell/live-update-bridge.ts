import type { NavigationService } from '@pragmatic-tech-ai/mural/framework/shell/services/navigation-service.js'
import { PortalSectionService } from './portal-section-service.js'

// Turns a control-plane change notification into a refresh of what the
// operator is looking at: the active rail section's current page only. The
// section keeps its page stack, so a detail page stays a detail page.
export class LiveUpdateBridge
{
    public constructor(private readonly nav: NavigationService)
    {
    }

    public async OnChanged(): Promise<void>
    {
        const active = this.nav.ActiveService
        if (active instanceof PortalSectionService)
        {
            await active.RefreshCurrent()
        }
    }
}
