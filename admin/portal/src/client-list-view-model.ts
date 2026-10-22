import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { ClientDto } from './portal-types.js'

// The slice of ControlPlaneClient the client list needs (a seam so tests need no live server).
export interface IClientListSource
{
    ListClients(): Promise<ClientDto[]>
    DeleteClient(id: string): Promise<void>
}

// Client list state: the loaded clients.
export class ClientListViewModel extends Observable
{
    public static readonly ClientsProperty = 'Clients'

    private clients: readonly ClientDto[] = []

    public constructor(private readonly source: IClientListSource)
    {
        super()
    }

    public get Clients(): readonly ClientDto[]
    {
        return this.clients
    }

    public async Load(): Promise<void>
    {
        const old = this.clients
        this.clients = await this.source.ListClients()
        this.RaisePropertyChanged(ClientListViewModel.ClientsProperty, old, this.clients)
    }

    public async Delete(id: string): Promise<void>
    {
        await this.source.DeleteClient(id)
    }
}
