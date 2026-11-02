import { ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { TenantSectionService } from '../../shell/tenant-section-service.js'
import type { TenantPageViewModel } from '../../shell/tenant-page-view-model.js'
import { ConnectionPageViewModel } from './connection-page-view-model.js'

// The Connection status rail section: one read-only page.
export class ConnectionSectionService extends TenantSectionService
{
    public static readonly Key = new ServiceKey<ConnectionSectionService>('ConnectionSectionService')

    public constructor(provider: IServiceProvider)
    {
        super(provider)
    }

    protected override CreateRoot(): TenantPageViewModel
    {
        return new ConnectionPageViewModel(this.Session)
    }
}
