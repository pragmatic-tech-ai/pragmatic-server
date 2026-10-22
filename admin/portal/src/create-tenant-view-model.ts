import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { ClientDto, TenantDto } from './portal-types.js'

// The slice of ControlPlaneClient the create-tenant form needs.
export interface ICreateTenantSource
{
    ListClients(): Promise<ClientDto[]>
    CreateTenant(id: string, clientId: string, displayName: string): Promise<TenantDto>
}

// Create-tenant form: the available clients, the chosen client id, and the fields.
export class CreateTenantViewModel extends Observable
{
    public static readonly ClientsProperty = 'Clients'
    public static readonly ClientIdProperty = 'ClientId'
    public static readonly IdProperty = 'Id'
    public static readonly DisplayNameProperty = 'DisplayName'
    private static readonly Empty = ''

    private clients: readonly ClientDto[] = []
    private clientId: string
    private id = CreateTenantViewModel.Empty
    private displayName = CreateTenantViewModel.Empty

    public constructor(private readonly source: ICreateTenantSource, initialClientId: string = CreateTenantViewModel.Empty)
    {
        super()
        this.clientId = initialClientId
    }

    public get Clients(): readonly ClientDto[]
    {
        return this.clients
    }

    public get ClientId(): string
    {
        return this.clientId
    }

    public set ClientId(value: string)
    {
        const old = this.clientId
        this.clientId = value
        this.RaisePropertyChanged(CreateTenantViewModel.ClientIdProperty, old, value)
    }

    public get Id(): string
    {
        return this.id
    }

    public set Id(value: string)
    {
        const old = this.id
        this.id = value
        this.RaisePropertyChanged(CreateTenantViewModel.IdProperty, old, value)
    }

    public get DisplayName(): string
    {
        return this.displayName
    }

    public set DisplayName(value: string)
    {
        const old = this.displayName
        this.displayName = value
        this.RaisePropertyChanged(CreateTenantViewModel.DisplayNameProperty, old, value)
    }

    public async Load(): Promise<void>
    {
        const old = this.clients
        this.clients = await this.source.ListClients()
        this.RaisePropertyChanged(CreateTenantViewModel.ClientsProperty, old, this.clients)
    }

    public async Submit(): Promise<TenantDto>
    {
        return await this.source.CreateTenant(this.id.trim(), this.clientId, this.displayName.trim())
    }
}
