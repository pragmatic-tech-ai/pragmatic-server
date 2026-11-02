import { ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { PortalSectionService } from '../../shell/portal-section-service.js'
import type { PortalPageViewModel } from '../../shell/portal-page-view-model.js'
import { HiveDetailPageViewModel } from './hive-detail-page-view-model.js'
import { HivesPageViewModel } from './hives-page-view-model.js'

// The Hives rail section: the hives list, then a hive's detail.
export class HivesSectionService extends PortalSectionService
{
    public static readonly Key = new ServiceKey<HivesSectionService>('HivesSectionService')

    public constructor(provider: IServiceProvider)
    {
        super(provider)
    }

    public OpenHive(id: string): void
    {
        this.Present(new HiveDetailPageViewModel(this.Session, this, id))
    }

    // Opened from another section (Fleet, a tenant's hive binding): shows the
    // hive's detail directly over the hives list and brings Hives to the front.
    public ShowHive(id: string): void
    {
        this.PresentOverRoot(new HiveDetailPageViewModel(this.Session, this, id))
        this.BringToFront()
    }

    protected override CreateRoot(): PortalPageViewModel
    {
        return new HivesPageViewModel(this.Session, this)
    }
}
