import { ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { TenantSectionService } from '../../shell/tenant-section-service.js'
import type { TenantPageViewModel } from '../../shell/tenant-page-view-model.js'
import { UsersAccessPageViewModel } from './users-access-page-view-model.js'

// The Users & Access rail section.
export class UsersAccessSectionService extends TenantSectionService
{
    public static readonly Key = new ServiceKey<UsersAccessSectionService>('UsersAccessSectionService')

    public constructor(provider: IServiceProvider)
    {
        super(provider)
    }

    protected override CreateRoot(): TenantPageViewModel
    {
        return new UsersAccessPageViewModel(this.Session)
    }
}
