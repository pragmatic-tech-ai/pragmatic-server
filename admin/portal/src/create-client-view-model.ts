import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { ClientDto } from './portal-types.js'

// The slice of ControlPlaneClient the create-client form needs.
export interface ICreateClientSink
{
    CreateClient(id: string, displayName: string, subscriptionRef?: string): Promise<ClientDto>
}

// Create-client form fields and submit.
export class CreateClientViewModel extends Observable
{
    public static readonly IdProperty = 'Id'
    public static readonly DisplayNameProperty = 'DisplayName'
    public static readonly SubscriptionRefProperty = 'SubscriptionRef'
    private static readonly Empty = ''

    private id = CreateClientViewModel.Empty
    private displayName = CreateClientViewModel.Empty
    private subscriptionRef = CreateClientViewModel.Empty

    public constructor(private readonly sink: ICreateClientSink)
    {
        super()
    }

    public get Id(): string
    {
        return this.id
    }

    public set Id(value: string)
    {
        const old = this.id
        this.id = value
        this.RaisePropertyChanged(CreateClientViewModel.IdProperty, old, value)
    }

    public get DisplayName(): string
    {
        return this.displayName
    }

    public set DisplayName(value: string)
    {
        const old = this.displayName
        this.displayName = value
        this.RaisePropertyChanged(CreateClientViewModel.DisplayNameProperty, old, value)
    }

    public get SubscriptionRef(): string
    {
        return this.subscriptionRef
    }

    public set SubscriptionRef(value: string)
    {
        const old = this.subscriptionRef
        this.subscriptionRef = value
        this.RaisePropertyChanged(CreateClientViewModel.SubscriptionRefProperty, old, value)
    }

    public async Submit(): Promise<ClientDto>
    {
        const sub = this.subscriptionRef.trim()
        return await this.sink.CreateClient(this.id.trim(), this.displayName.trim(), sub.length > 0 ? sub : undefined)
    }
}
