import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { HiveClusterBackend, HiveDto, HiveProvisionMode } from './portal-types.js'

// The slice of ControlPlaneClient the create-hive form needs.
export interface ICreateHiveSink
{
    CreateHive(input: HiveDto): Promise<HiveDto>
}

// Create-hive form state. Optional inputs are reference NAMES only; no secret values.
export class CreateHiveViewModel extends Observable
{
    public static readonly Backends: readonly HiveClusterBackend[] = ['aks', 'eks', 'gke', 'private', 'local']
    public static readonly Modes: readonly HiveProvisionMode[] = ['provision', 'attach']
    public static readonly IdProperty = 'Id'
    public static readonly DisplayNameProperty = 'DisplayName'
    public static readonly BackendProperty = 'Backend'
    public static readonly ClusterModeProperty = 'ClusterMode'
    public static readonly ConfigRefProperty = 'ConfigRef'
    public static readonly RegistryModeProperty = 'RegistryMode'
    public static readonly EndpointProperty = 'Endpoint'
    public static readonly CredentialRefProperty = 'CredentialRef'
    public static readonly TrustRootRefProperty = 'TrustRootRef'
    private static readonly Empty = ''

    private id = CreateHiveViewModel.Empty
    private displayName = CreateHiveViewModel.Empty
    private backend: HiveClusterBackend = 'local'
    private clusterMode: HiveProvisionMode = 'attach'
    private configRef = CreateHiveViewModel.Empty
    private registryMode: HiveProvisionMode = 'attach'
    private endpoint = CreateHiveViewModel.Empty
    private credentialRef = CreateHiveViewModel.Empty
    private trustRootRef = CreateHiveViewModel.Empty

    public constructor(private readonly sink: ICreateHiveSink, public readonly TenantId: string)
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
        this.RaisePropertyChanged(CreateHiveViewModel.IdProperty, old, value)
    }

    public get DisplayName(): string
    {
        return this.displayName
    }

    public set DisplayName(value: string)
    {
        const old = this.displayName
        this.displayName = value
        this.RaisePropertyChanged(CreateHiveViewModel.DisplayNameProperty, old, value)
    }

    public get Backend(): HiveClusterBackend
    {
        return this.backend
    }

    public set Backend(value: HiveClusterBackend)
    {
        const old = this.backend
        this.backend = value
        this.RaisePropertyChanged(CreateHiveViewModel.BackendProperty, old, value)
    }

    public get ClusterMode(): HiveProvisionMode
    {
        return this.clusterMode
    }

    public set ClusterMode(value: HiveProvisionMode)
    {
        const old = this.clusterMode
        this.clusterMode = value
        this.RaisePropertyChanged(CreateHiveViewModel.ClusterModeProperty, old, value)
    }

    public get ConfigRef(): string
    {
        return this.configRef
    }

    public set ConfigRef(value: string)
    {
        const old = this.configRef
        this.configRef = value
        this.RaisePropertyChanged(CreateHiveViewModel.ConfigRefProperty, old, value)
    }

    public get RegistryMode(): HiveProvisionMode
    {
        return this.registryMode
    }

    public set RegistryMode(value: HiveProvisionMode)
    {
        const old = this.registryMode
        this.registryMode = value
        this.RaisePropertyChanged(CreateHiveViewModel.RegistryModeProperty, old, value)
    }

    public get Endpoint(): string
    {
        return this.endpoint
    }

    public set Endpoint(value: string)
    {
        const old = this.endpoint
        this.endpoint = value
        this.RaisePropertyChanged(CreateHiveViewModel.EndpointProperty, old, value)
    }

    public get CredentialRef(): string
    {
        return this.credentialRef
    }

    public set CredentialRef(value: string)
    {
        const old = this.credentialRef
        this.credentialRef = value
        this.RaisePropertyChanged(CreateHiveViewModel.CredentialRefProperty, old, value)
    }

    public get TrustRootRef(): string
    {
        return this.trustRootRef
    }

    public set TrustRootRef(value: string)
    {
        const old = this.trustRootRef
        this.trustRootRef = value
        this.RaisePropertyChanged(CreateHiveViewModel.TrustRootRefProperty, old, value)
    }

    public async Submit(): Promise<HiveDto>
    {
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
        const input: HiveDto = { id: this.id.trim(), tenantId: this.TenantId, displayName: this.displayName.trim(), cluster, registry }
        const trustRootRef = this.trustRootRef.trim()
        if (trustRootRef.length > 0)
        {
            input.trustRootRef = trustRootRef
        }
        return await this.sink.CreateHive(input)
    }
}
