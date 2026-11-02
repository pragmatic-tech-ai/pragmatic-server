import { ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { TenantSectionService } from '../../shell/tenant-section-service.js'
import type { TenantPageViewModel } from '../../shell/tenant-page-view-model.js'
import { SettingsPageViewModel } from './settings-page-view-model.js'

// The Settings rail section.
export class SettingsSectionService extends TenantSectionService
{
    public static readonly Key = new ServiceKey<SettingsSectionService>('SettingsSectionService')

    public constructor(provider: IServiceProvider)
    {
        super(provider)
    }

    protected override CreateRoot(): TenantPageViewModel
    {
        return new SettingsPageViewModel(this.Session)
    }
}
