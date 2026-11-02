import { ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { TenantEventType, type TenantEvent } from '../../tenant-types.js'
import { TenantSectionService } from '../../shell/tenant-section-service.js'
import type { TenantPageViewModel } from '../../shell/tenant-page-view-model.js'
import { ReleasesSectionService } from '../releases/releases-section-service.js'
import { EnvironmentDetailPageViewModel } from './environment-detail-page-view-model.js'
import { EnvironmentsPageViewModel } from './environments-page-view-model.js'

// The Environments rail section: the environments list and an environment's
// detail. Other sections open a detail here (OpenEnvironment brings the
// section to the front). When the environment on screen is deleted (by this
// operator or anyone else) the section drops back to the list.
export class EnvironmentsSectionService extends TenantSectionService
{
    public static readonly Key = new ServiceKey<EnvironmentsSectionService>('EnvironmentsSectionService')

    public constructor(provider: IServiceProvider)
    {
        super(provider)
    }

    // Shows `name`'s detail directly over the list and brings Environments
    // to the front.
    public OpenEnvironment(name: string): void
    {
        this.PresentOverRoot(new EnvironmentDetailPageViewModel(this.Session, this, name))
        this.BringToFront()
    }

    // Opens the adopt wizard in Releases on `version`.
    public OpenAdopt(version: string): void
    {
        this.Provider.get(ReleasesSectionService.Key)?.OpenAdopt(version)
    }

    // After `page`'s environment was deleted: back to the list (reloaded)
    // when that page is still on top, else just reload what is.
    public async ReturnFromDeleted(page: EnvironmentDetailPageViewModel): Promise<void>
    {
        if (this.Current === page)
        {
            await this.BackAndRefresh()
            return
        }
        await this.RefreshCurrent()
    }

    public override async OnTenantEvent(ev: TenantEvent): Promise<void>
    {
        const current = this.Current
        if (ev.type === TenantEventType.EnvironmentDeleted
            && current instanceof EnvironmentDetailPageViewModel
            && current.Name === ev.environmentName)
        {
            await this.BackAndRefresh()
            return
        }
        await super.OnTenantEvent(ev)
    }

    protected override CreateRoot(): TenantPageViewModel
    {
        return new EnvironmentsPageViewModel(this.Session, this)
    }
}
