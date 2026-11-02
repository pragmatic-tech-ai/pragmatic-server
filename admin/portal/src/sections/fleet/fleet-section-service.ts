import { ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { PortalSectionService } from '../../shell/portal-section-service.js'
import type { PortalPageViewModel } from '../../shell/portal-page-view-model.js'
import { FleetPageViewModel } from './fleet-page-view-model.js'

// The Fleet rail section: its root page is the fleet overview.
export class FleetSectionService extends PortalSectionService
{
    public static readonly Key = new ServiceKey<FleetSectionService>('FleetSectionService')

    public constructor(provider: IServiceProvider)
    {
        super(provider)
    }

    protected override CreateRoot(): PortalPageViewModel
    {
        return new FleetPageViewModel(this.Session)
    }
}
