import { ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import type { ActivityDto } from '../../portal-types.js'
import { PortalSectionService } from '../../shell/portal-section-service.js'
import type { PortalPageViewModel } from '../../shell/portal-page-view-model.js'
import { ActivityEntryPageViewModel } from './activity-entry-page-view-model.js'
import { ActivityPageViewModel } from './activity-page-view-model.js'

// The Activity rail section: the audit log, then an entry's detail.
export class ActivitySectionService extends PortalSectionService
{
    public static readonly Key = new ServiceKey<ActivitySectionService>('ActivitySectionService')

    public constructor(provider: IServiceProvider)
    {
        super(provider)
    }

    public OpenEntry(entry: ActivityDto): void
    {
        this.Present(new ActivityEntryPageViewModel(this.Session, this, entry))
    }

    protected override CreateRoot(): PortalPageViewModel
    {
        return new ActivityPageViewModel(this.Session, this)
    }
}
