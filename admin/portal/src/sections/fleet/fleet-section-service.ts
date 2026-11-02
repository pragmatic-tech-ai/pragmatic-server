import { ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { PortalSectionService } from '../../shell/portal-section-service.js'
import type { PortalPageViewModel } from '../../shell/portal-page-view-model.js'
import { HivesSectionService } from '../hives/hives-section-service.js'
import { FleetPageViewModel } from './fleet-page-view-model.js'

// The Fleet rail section: its root page is the fleet overview. Opening a hive
// shows its detail in the Hives section, which comes to the front.
export class FleetSectionService extends PortalSectionService
{
    public static readonly Key = new ServiceKey<FleetSectionService>('FleetSectionService')

    public constructor(provider: IServiceProvider)
    {
        super(provider)
    }

    public OpenHive(id: string): void
    {
        this.Provider.get(HivesSectionService.Key)?.ShowHive(id)
    }

    protected override CreateRoot(): PortalPageViewModel
    {
        return new FleetPageViewModel(this.Session, this)
    }
}
