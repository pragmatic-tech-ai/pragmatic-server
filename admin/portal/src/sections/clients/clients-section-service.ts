import { ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { PortalSectionService } from '../../shell/portal-section-service.js'
import type { PortalPageViewModel } from '../../shell/portal-page-view-model.js'
import { ClientDetailPageViewModel } from './client-detail-page-view-model.js'
import { ClientsPageViewModel } from './clients-page-view-model.js'

// The Clients rail section: the clients list, then a client's detail.
export class ClientsSectionService extends PortalSectionService
{
    public static readonly Key = new ServiceKey<ClientsSectionService>('ClientsSectionService')

    public constructor(provider: IServiceProvider)
    {
        super(provider)
    }

    public OpenClient(id: string): void
    {
        this.Present(new ClientDetailPageViewModel(this.Session, this, id))
    }

    protected override CreateRoot(): PortalPageViewModel
    {
        return new ClientsPageViewModel(this.Session, this)
    }
}
