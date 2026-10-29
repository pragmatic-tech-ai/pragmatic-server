import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { HiveClusterBackend, HiveDto, HiveProvisionMode, ProvisionInputDto, ProvisionResultDto } from './portal-types.js'

export enum WizardStep
{
    Client,
    Tenant,
    Hive
}

// The slice of ControlPlaneClient the provisioning wizard needs.
export interface IProvisionSink
{
    Provision(input: ProvisionInputDto): Promise<ProvisionResultDto>
}

// Wizard form state. Provision() RETURNS the result (which carries one-time secrets) and never stores it.
export class ProvisionWizardViewModel extends Observable
{
    public static readonly ClientIdProperty = 'ClientId'
    public static readonly ClientDisplayNameProperty = 'ClientDisplayName'
    public static readonly SubscriptionRefProperty = 'SubscriptionRef'
    public static readonly TenantIdProperty = 'TenantId'
    public static readonly TenantDisplayNameProperty = 'TenantDisplayName'
    public static readonly OwnerEmailProperty = 'OwnerEmail'
    public static readonly HiveIdProperty = 'HiveId'
    public static readonly HiveDisplayNameProperty = 'HiveDisplayName'
    public static readonly BackendProperty = 'Backend'
    public static readonly ClusterModeProperty = 'ClusterMode'
    public static readonly ConfigRefProperty = 'ConfigRef'
    public static readonly RegistryModeProperty = 'RegistryMode'
    public static readonly EndpointProperty = 'Endpoint'
    public static readonly CredentialRefProperty = 'CredentialRef'
    public static readonly TrustRootRefProperty = 'TrustRootRef'
    private static readonly Empty = ''

    private clientId = ProvisionWizardViewModel.Empty
    private clientDisplayName = ProvisionWizardViewModel.Empty
    private subscriptionRef = ProvisionWizardViewModel.Empty
    private tenantId = ProvisionWizardViewModel.Empty
    private tenantDisplayName = ProvisionWizardViewModel.Empty
    private ownerEmail = ProvisionWizardViewModel.Empty
    private hiveId = ProvisionWizardViewModel.Empty
    private hiveDisplayName = ProvisionWizardViewModel.Empty
    private backend: HiveClusterBackend = 'local'
    private clusterMode: HiveProvisionMode = 'attach'
    private configRef = ProvisionWizardViewModel.Empty
    private registryMode: HiveProvisionMode = 'attach'
    private endpoint = ProvisionWizardViewModel.Empty
    private credentialRef = ProvisionWizardViewModel.Empty
    private trustRootRef = ProvisionWizardViewModel.Empty

    public constructor(private readonly sink: IProvisionSink)
    {
        super()
    }

    public get ClientId(): string
    {
        return this.clientId
    }

    public set ClientId(value: string)
    {
        const old = this.clientId
        this.clientId = value
        this.RaisePropertyChanged(ProvisionWizardViewModel.ClientIdProperty, old, value)
    }

    public get ClientDisplayName(): string
    {
        return this.clientDisplayName
    }

    public set ClientDisplayName(value: string)
    {
        const old = this.clientDisplayName
        this.clientDisplayName = value
        this.RaisePropertyChanged(ProvisionWizardViewModel.ClientDisplayNameProperty, old, value)
    }

    public get SubscriptionRef(): string
    {
        return this.subscriptionRef
    }

    public set SubscriptionRef(value: string)
    {
        const old = this.subscriptionRef
        this.subscriptionRef = value
        this.RaisePropertyChanged(ProvisionWizardViewModel.SubscriptionRefProperty, old, value)
    }

    public get TenantId(): string
    {
        return this.tenantId
    }

    public set TenantId(value: string)
    {
        const old = this.tenantId
        this.tenantId = value
        this.RaisePropertyChanged(ProvisionWizardViewModel.TenantIdProperty, old, value)
    }

    public get TenantDisplayName(): string
    {
        return this.tenantDisplayName
    }

    public set TenantDisplayName(value: string)
    {
        const old = this.tenantDisplayName
        this.tenantDisplayName = value
        this.RaisePropertyChanged(ProvisionWizardViewModel.TenantDisplayNameProperty, old, value)
    }

    public get OwnerEmail(): string
    {
        return this.ownerEmail
    }

    public set OwnerEmail(value: string)
    {
        const old = this.ownerEmail
        this.ownerEmail = value
        this.RaisePropertyChanged(ProvisionWizardViewModel.OwnerEmailProperty, old, value)
    }

    public get HiveId(): string
    {
        return this.hiveId
    }

    public set HiveId(value: string)
    {
        const old = this.hiveId
        this.hiveId = value
        this.RaisePropertyChanged(ProvisionWizardViewModel.HiveIdProperty, old, value)
    }

    public get HiveDisplayName(): string
    {
        return this.hiveDisplayName
    }

    public set HiveDisplayName(value: string)
    {
        const old = this.hiveDisplayName
        this.hiveDisplayName = value
        this.RaisePropertyChanged(ProvisionWizardViewModel.HiveDisplayNameProperty, old, value)
    }

    public get Backend(): HiveClusterBackend
    {
        return this.backend
    }

    public set Backend(value: HiveClusterBackend)
    {
        const old = this.backend
        this.backend = value
        this.RaisePropertyChanged(ProvisionWizardViewModel.BackendProperty, old, value)
    }

    public get ClusterMode(): HiveProvisionMode
    {
        return this.clusterMode
    }

    public set ClusterMode(value: HiveProvisionMode)
    {
        const old = this.clusterMode
        this.clusterMode = value
        this.RaisePropertyChanged(ProvisionWizardViewModel.ClusterModeProperty, old, value)
    }

    public get ConfigRef(): string
    {
        return this.configRef
    }

    public set ConfigRef(value: string)
    {
        const old = this.configRef
        this.configRef = value
        this.RaisePropertyChanged(ProvisionWizardViewModel.ConfigRefProperty, old, value)
    }

    public get RegistryMode(): HiveProvisionMode
    {
        return this.registryMode
    }

    public set RegistryMode(value: HiveProvisionMode)
    {
        const old = this.registryMode
        this.registryMode = value
        this.RaisePropertyChanged(ProvisionWizardViewModel.RegistryModeProperty, old, value)
    }

    public get Endpoint(): string
    {
        return this.endpoint
    }

    public set Endpoint(value: string)
    {
        const old = this.endpoint
        this.endpoint = value
        this.RaisePropertyChanged(ProvisionWizardViewModel.EndpointProperty, old, value)
    }

    public get CredentialRef(): string
    {
        return this.credentialRef
    }

    public set CredentialRef(value: string)
    {
        const old = this.credentialRef
        this.credentialRef = value
        this.RaisePropertyChanged(ProvisionWizardViewModel.CredentialRefProperty, old, value)
    }

    public get TrustRootRef(): string
    {
        return this.trustRootRef
    }

    public set TrustRootRef(value: string)
    {
        const old = this.trustRootRef
        this.trustRootRef = value
        this.RaisePropertyChanged(ProvisionWizardViewModel.TrustRootRefProperty, old, value)
    }

    public StepValid(step: WizardStep): boolean
    {
        switch (step)
        {
            case WizardStep.Client:
                return this.Filled(this.clientId) && this.Filled(this.clientDisplayName)
            case WizardStep.Tenant:
                return this.Filled(this.tenantId) && this.Filled(this.tenantDisplayName) && this.Filled(this.ownerEmail)
            case WizardStep.Hive:
                return this.Filled(this.hiveId) && this.Filled(this.hiveDisplayName)
            default:
                return false
        }
    }

    public CanProvision(): boolean
    {
        return this.StepValid(WizardStep.Client) && this.StepValid(WizardStep.Tenant) && this.StepValid(WizardStep.Hive)
    }

    public async Provision(): Promise<ProvisionResultDto>
    {
        const client: ProvisionInputDto['client'] = { id: this.clientId.trim(), displayName: this.clientDisplayName.trim() }
        const subscriptionRef = this.subscriptionRef.trim()
        if (subscriptionRef.length > 0)
        {
            client.subscriptionRef = subscriptionRef
        }
        const cluster: HiveDto['cluster'] = { backend: this.backend, mode: this.clusterMode }
        const configRef = this.configRef.trim()
        if (configRef.length > 0)
        {
            cluster.configRef = configRef
        }
        const registry: HiveDto['registry'] = { mode: this.registryMode }
        const endpoint = this.endpoint.trim()
        if (endpoint.length > 0)
        {
            registry.endpoint = endpoint
        }
        const credentialRef = this.credentialRef.trim()
        if (credentialRef.length > 0)
        {
            registry.credentialRef = credentialRef
        }
        const hive: ProvisionInputDto['hive'] = { id: this.hiveId.trim(), displayName: this.hiveDisplayName.trim(), cluster, registry }
        const trustRootRef = this.trustRootRef.trim()
        if (trustRootRef.length > 0)
        {
            hive.trustRootRef = trustRootRef
        }
        const tenant: ProvisionInputDto['tenant'] = { id: this.tenantId.trim(), displayName: this.tenantDisplayName.trim(), ownerEmail: this.ownerEmail.trim() }
        return await this.sink.Provision({ client, tenant, hive })
    }

    private Filled(value: string): boolean
    {
        return value.trim().length > 0
    }
}
