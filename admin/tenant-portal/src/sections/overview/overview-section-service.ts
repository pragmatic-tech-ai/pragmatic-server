import { RelayCommand, ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { TenantSectionService } from '../../shell/tenant-section-service.js'
import type { TenantPageViewModel } from '../../shell/tenant-page-view-model.js'
import { ActivityPageViewModel } from './activity-page-view-model.js'
import { OverviewPageViewModel } from './overview-page-view-model.js'

// The Overview rail section (home): the Overview page, and the Activity page
// it (and the header's Activity button) opens.
export class OverviewSectionService extends TenantSectionService
{
    public static readonly Key = new ServiceKey<OverviewSectionService>('OverviewSectionService')

    private static readonly ActivityText = 'Activity'

    private activity: ActivityPageViewModel | undefined
    private readonly openActivityCommand: RelayCommand

    public constructor(provider: IServiceProvider)
    {
        super(provider)
        this.openActivityCommand = new RelayCommand(() => this.OpenActivity(), undefined, { Text: OverviewSectionService.ActivityText })
    }

    // Brings Overview to the front showing the session's activity.
    public get OpenActivityCommand(): RelayCommand
    {
        return this.openActivityCommand
    }

    public OpenActivity(): void
    {
        this.activity ??= new ActivityPageViewModel(this.Session, this.BackCommand)
        if (this.Current !== this.activity)
        {
            this.PresentOverRoot(this.activity)
        }
        this.BringToFront()
    }

    protected override CreateRoot(): TenantPageViewModel
    {
        return new OverviewPageViewModel(this.Session, this)
    }
}
