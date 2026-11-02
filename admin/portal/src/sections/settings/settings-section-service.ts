import { ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { PortalSectionService } from '../../shell/portal-section-service.js'
import type { PortalPageViewModel } from '../../shell/portal-page-view-model.js'
import { SettingsPageViewModel } from './settings-page-view-model.js'

// The Settings rail section: one page with the profile and the operator roster.
export class SettingsSectionService extends PortalSectionService
{
    public static readonly Key = new ServiceKey<SettingsSectionService>('SettingsSectionService')

    public constructor(provider: IServiceProvider)
    {
        super(provider)
    }

    protected override CreateRoot(): PortalPageViewModel
    {
        return new SettingsPageViewModel(this.Session, this)
    }
}
