import { ObservableCollection } from '@pragmatic-tech-ai/mural/runtime'
import type { DialogService } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import type { HiveClusterBackend, HiveDto, HiveProvisionMode } from '../../portal-types.js'
import { OptionViewModel } from '../../shell/option-view-model.js'
import { PortalDialogViewModel } from '../../shell/portal-dialog-view-model.js'
import type { PortalSessionService } from '../../shell/portal-session-service.js'
import { HiveOptions } from './hive-options.js'

// Create hive: registers a hive record for a tenant that has none yet (one
// tenant, one hive). Cluster and registry settings take reference NAMES only;
// no secret value is entered here.
export class NewHiveDialogViewModel extends PortalDialogViewModel<HiveDto>
{
    private static readonly SelectedTenantProperty = 'SelectedTenant'
    private static readonly HasNoFreeTenantProperty = 'HasNoFreeTenant'
    private static readonly IdProperty = 'Id'
    private static readonly DisplayNameProperty = 'DisplayName'
    private static readonly SelectedBackendProperty = 'SelectedBackend'
    private static readonly SelectedClusterModeProperty = 'SelectedClusterMode'
    private static readonly ConfigRefProperty = 'ConfigRef'
    private static readonly SelectedRegistryModeProperty = 'SelectedRegistryMode'
    private static readonly EndpointProperty = 'Endpoint'
    private static readonly CredentialRefProperty = 'CredentialRef'
    private static readonly TrustRootRefProperty = 'TrustRootRef'
    private static readonly TenantLabelSeparator = ' / '
    private static readonly IncompleteMessage = 'Choose a tenant, a cluster, a cluster mode and a registry mode.'

    private readonly tenants = new ObservableCollection<OptionViewModel<string>>()
    private readonly backends = new ObservableCollection<OptionViewModel<HiveClusterBackend>>()
    private readonly clusterModes = new ObservableCollection<OptionViewModel<HiveProvisionMode>>()
    private readonly registryModes = new ObservableCollection<OptionViewModel<HiveProvisionMode>>()
    private selectedTenant: OptionViewModel<string> | undefined
    private id = ''
    private displayName = ''
    private selectedBackend: OptionViewModel<HiveClusterBackend> | undefined
    private selectedClusterMode: OptionViewModel<HiveProvisionMode> | undefined
    private configRef = ''
    private selectedRegistryMode: OptionViewModel<HiveProvisionMode> | undefined
    private endpoint = ''
    private credentialRef = ''
    private trustRootRef = ''

    public constructor(session: PortalSessionService, dialogs: DialogService)
    {
        super(session, dialogs)
        HiveOptions.Backends().forEach(o => this.backends.Add(o))
        HiveOptions.Modes().forEach(o => this.clusterModes.Add(o))
        HiveOptions.Modes().forEach(o => this.registryModes.Add(o))
        this.selectedBackend = this.backends.Get(0)
        this.selectedClusterMode = this.clusterModes.Get(0)
        this.selectedRegistryMode = this.registryModes.Get(0)
    }

    // Fills the tenant choices: tenants that no hive serves yet.
    public override async Load(): Promise<void>
    {
        const api = this.Session.Client
        const [tenants, clients, hives] = await Promise.all([api.ListTenants(), api.ListClients(), api.ListHives()])
        const served = new Set(hives.map(h => h.tenantId))
        const hadNone = this.HasNoFreeTenant
        this.tenants.Clear()
        for (const tenant of tenants.filter(t => !served.has(t.id)))
        {
            const client = clients.find(c => c.id === tenant.clientId)
            const label = client === undefined ? tenant.displayName : client.displayName + NewHiveDialogViewModel.TenantLabelSeparator + tenant.displayName
            this.tenants.Add(new OptionViewModel(tenant.id, label))
        }
        this.RaisePropertyChanged(NewHiveDialogViewModel.HasNoFreeTenantProperty, hadNone, this.HasNoFreeTenant)
    }

    public get Tenants(): ObservableCollection<OptionViewModel<string>>
    {
        return this.tenants
    }

    // True when every tenant already has its hive.
    public get HasNoFreeTenant(): boolean
    {
        return this.tenants.Count === 0
    }

    public get SelectedTenant(): OptionViewModel<string> | undefined
    {
        return this.selectedTenant
    }

    public set SelectedTenant(value: OptionViewModel<string> | undefined)
    {
        this.SetField(NewHiveDialogViewModel.SelectedTenantProperty, this.selectedTenant, value, v => { this.selectedTenant = v })
    }

    public get Id(): string
    {
        return this.id
    }

    public set Id(value: string)
    {
        this.SetField(NewHiveDialogViewModel.IdProperty, this.id, value, v => { this.id = v })
    }

    public get DisplayName(): string
    {
        return this.displayName
    }

    public set DisplayName(value: string)
    {
        this.SetField(NewHiveDialogViewModel.DisplayNameProperty, this.displayName, value, v => { this.displayName = v })
    }

    public get Backends(): ObservableCollection<OptionViewModel<HiveClusterBackend>>
    {
        return this.backends
    }

    public get SelectedBackend(): OptionViewModel<HiveClusterBackend> | undefined
    {
        return this.selectedBackend
    }

    public set SelectedBackend(value: OptionViewModel<HiveClusterBackend> | undefined)
    {
        this.SetField(NewHiveDialogViewModel.SelectedBackendProperty, this.selectedBackend, value, v => { this.selectedBackend = v })
    }

    public get ClusterModes(): ObservableCollection<OptionViewModel<HiveProvisionMode>>
    {
        return this.clusterModes
    }

    public get SelectedClusterMode(): OptionViewModel<HiveProvisionMode> | undefined
    {
        return this.selectedClusterMode
    }

    public set SelectedClusterMode(value: OptionViewModel<HiveProvisionMode> | undefined)
    {
        this.SetField(NewHiveDialogViewModel.SelectedClusterModeProperty, this.selectedClusterMode, value, v => { this.selectedClusterMode = v })
    }

    public get ConfigRef(): string
    {
        return this.configRef
    }

    public set ConfigRef(value: string)
    {
        this.SetField(NewHiveDialogViewModel.ConfigRefProperty, this.configRef, value, v => { this.configRef = v })
    }

    public get RegistryModes(): ObservableCollection<OptionViewModel<HiveProvisionMode>>
    {
        return this.registryModes
    }

    public get SelectedRegistryMode(): OptionViewModel<HiveProvisionMode> | undefined
    {
        return this.selectedRegistryMode
    }

    public set SelectedRegistryMode(value: OptionViewModel<HiveProvisionMode> | undefined)
    {
        this.SetField(NewHiveDialogViewModel.SelectedRegistryModeProperty, this.selectedRegistryMode, value, v => { this.selectedRegistryMode = v })
    }

    public get Endpoint(): string
    {
        return this.endpoint
    }

    public set Endpoint(value: string)
    {
        this.SetField(NewHiveDialogViewModel.EndpointProperty, this.endpoint, value, v => { this.endpoint = v })
    }

    public get CredentialRef(): string
    {
        return this.credentialRef
    }

    public set CredentialRef(value: string)
    {
        this.SetField(NewHiveDialogViewModel.CredentialRefProperty, this.credentialRef, value, v => { this.credentialRef = v })
    }

    public get TrustRootRef(): string
    {
        return this.trustRootRef
    }

    public set TrustRootRef(value: string)
    {
        this.SetField(NewHiveDialogViewModel.TrustRootRefProperty, this.trustRootRef, value, v => { this.trustRootRef = v })
    }

    protected override get CanConfirm(): boolean
    {
        return this.selectedTenant !== undefined
            && this.selectedBackend !== undefined
            && this.selectedClusterMode !== undefined
            && this.selectedRegistryMode !== undefined
            && this.id.trim().length > 0
            && this.displayName.trim().length > 0
    }

    protected override async SubmitCore(): Promise<HiveDto>
    {
        const input = this.BuildInput()
        if (input === undefined)
        {
            throw new Error(NewHiveDialogViewModel.IncompleteMessage)
        }
        return await this.Session.Client.CreateHive(input)
    }

    // The hive record from the form; undefined while a choice is missing.
    private BuildInput(): HiveDto | undefined
    {
        const tenant = this.selectedTenant
        const backend = this.selectedBackend
        const clusterMode = this.selectedClusterMode
        const registryMode = this.selectedRegistryMode
        if (tenant === undefined || backend === undefined || clusterMode === undefined || registryMode === undefined)
        {
            return undefined
        }
        const cluster: HiveDto['cluster'] = { backend: backend.Value, mode: clusterMode.Value }
        const configRef = this.configRef.trim()
        if (configRef.length > 0)
        {
            cluster.configRef = configRef
        }
        const registry: HiveDto['registry'] = { mode: registryMode.Value }
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
        const input: HiveDto = { id: this.id.trim(), tenantId: tenant.Value, displayName: this.displayName.trim(), cluster, registry }
        const trustRootRef = this.trustRootRef.trim()
        if (trustRootRef.length > 0)
        {
            input.trustRootRef = trustRootRef
        }
        return input
    }
}
