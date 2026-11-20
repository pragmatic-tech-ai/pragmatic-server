import { ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { TenantSectionService } from '../../shell/tenant-section-service.js'
import type { TenantPageViewModel } from '../../shell/tenant-page-view-model.js'
import { ComponentConfigurationPageViewModel } from './component-configuration-page-view-model.js'
import { ConfigurationPageViewModel, type IConfigurationNavigator } from './configuration-page-view-model.js'

// The Configuration rail section: the components this console holds configuration for, and one component's page.
export class ConfigurationSectionService extends TenantSectionService implements IConfigurationNavigator
{
    public static readonly Key = new ServiceKey<ConfigurationSectionService>('ConfigurationSectionService')

    public constructor(provider: IServiceProvider)
    {
        super(provider)
    }

    public OpenComponent(component: string): void
    {
        this.Present(new ComponentConfigurationPageViewModel(this.Session, this, component))
    }

    protected override CreateRoot(): TenantPageViewModel
    {
        return new ConfigurationPageViewModel(this.Session, this)
    }
}
