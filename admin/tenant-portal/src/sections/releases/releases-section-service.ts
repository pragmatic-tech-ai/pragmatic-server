import { ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { TenantSectionService } from '../../shell/tenant-section-service.js'
import type { TenantPageViewModel } from '../../shell/tenant-page-view-model.js'
import { EnvironmentsSectionService } from '../environments/environments-section-service.js'
import { AdoptWizardPageViewModel, type IAdoptNavigator } from './adopt-wizard-page-view-model.js'
import { ReleasesPageViewModel, type IReleasesNavigator } from './releases-page-view-model.js'

// The Releases rail section: the Releases page, and the adopt wizard over it.
export class ReleasesSectionService extends TenantSectionService implements IReleasesNavigator, IAdoptNavigator
{
    public static readonly Key = new ServiceKey<ReleasesSectionService>('ReleasesSectionService')

    public constructor(provider: IServiceProvider)
    {
        super(provider)
    }

    // Brings Releases to the front on the adopt wizard, preselecting
    // `version` when given (the newest offer otherwise). Overview's offer
    // banner and an environment's "Newer version offered" call it too. A
    // wizard already past its Version step is kept (pending work), not
    // replaced.
    public OpenAdopt(version?: string): void
    {
        this.PresentOverRoot(new AdoptWizardPageViewModel(this.Session, this, version))
        this.BringToFront()
    }

    public async BackToReleases(): Promise<void>
    {
        await this.BackAndRefresh()
    }

    public CancelAdopt(): void
    {
        this.Back()
    }

    // Leaves the wizard (Releases shows its list next time) and brings the
    // Environments section to the front.
    public ShowEnvironments(): void
    {
        this.Back()
        this.Provider.get(EnvironmentsSectionService.Key)?.BringToFront()
    }

    protected override CreateRoot(): TenantPageViewModel
    {
        return new ReleasesPageViewModel(this.Session, this)
    }
}
