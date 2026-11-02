import { ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { PortalSectionService } from '../../shell/portal-section-service.js'
import type { PortalPageViewModel } from '../../shell/portal-page-view-model.js'
import { HiveDetailPageViewModel } from './hive-detail-page-view-model.js'
import { HivesPageViewModel } from './hives-page-view-model.js'
import { ProvisionWizardPageViewModel } from './provision-wizard-page-view-model.js'

// The Hives rail section: the hives list, a hive's detail, and the Stand up
// a hive wizard (which ends on its one-time Bootstrap reveal).
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

    // Opens the Stand up a hive wizard over the current page.
    public StandUp(): void
    {
        this.Present(new ProvisionWizardPageViewModel(this.Session, this))
    }

    // After the wizard's one-time values are confirmed: the wizard gives way
    // to the new hive's detail over a refreshed list, so Back skips the
    // cleared wizard and lists the new hive.
    public ShowHiveAfterProvision(id: string): void
    {
        this.Back()
        void this.RefreshCurrent()
        this.OpenHive(id)
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
