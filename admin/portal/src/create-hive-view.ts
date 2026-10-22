import { TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { ComboBox } from '@pragmatic-tech-ai/mural/framework'
import type { ControlPlaneClient } from './api-client.js'
import { CreateHiveViewModel } from './create-hive-view-model.js'
import type { HiveClusterBackend, HiveProvisionMode, IPortalNavigator } from './portal-types.js'
import { PortalViewBase } from './portal-view-base.js'

// ComboBox item: the collapsed selection renders Label; Value is the picked option.
export class HiveOption
{
    public constructor(public readonly Label: string, public readonly Value: string)
    {
    }
}

// Create-hive form: cluster + registry pickers, reference-name inputs only (no secrets).
export class CreateHiveView extends PortalViewBase
{
    public static readonly IdPlaceholder = 'Hive id'
    public static readonly BackendPlaceholder = 'Cluster backend'
    public static readonly ClusterModePlaceholder = 'Cluster mode'
    public static readonly ConfigRefPlaceholder = 'Cluster config ref (optional)'
    public static readonly RegistryModePlaceholder = 'Registry mode'
    public static readonly EndpointPlaceholder = 'Registry endpoint (optional)'
    public static readonly CredentialRefPlaceholder = 'Registry credential ref (optional)'
    public static readonly TrustRootRefPlaceholder = 'Trust root ref (optional)'
    private static readonly HeadingPrefix = 'New hive for '
    private static readonly LabelPath = 'Label'

    private readonly vm: CreateHiveViewModel
    private readonly idBox = new TextBox()
    private readonly nameBox = new TextBox()
    private readonly backendBox = new ComboBox()
    private readonly clusterModeBox = new ComboBox()
    private readonly configRefBox = new TextBox()
    private readonly registryModeBox = new ComboBox()
    private readonly endpointBox = new TextBox()
    private readonly credentialRefBox = new TextBox()
    private readonly trustRootRefBox = new TextBox()

    public constructor(client: ControlPlaneClient, private readonly nav: IPortalNavigator, private readonly clientId: string, private readonly tenantId: string)
    {
        super()
        this.vm = new CreateHiveViewModel(client, tenantId)
        const heading = new TextBlock()
        heading.Text = CreateHiveView.HeadingPrefix + tenantId
        this.AddChild(heading)
        this.AddText(this.idBox, CreateHiveView.IdPlaceholder)
        this.AddText(this.nameBox, PortalViewBase.DisplayNamePlaceholder)
        this.AddPicker(this.backendBox, CreateHiveView.BackendPlaceholder, CreateHiveViewModel.Backends, this.vm.Backend)
        this.AddPicker(this.clusterModeBox, CreateHiveView.ClusterModePlaceholder, CreateHiveViewModel.Modes, this.vm.ClusterMode)
        this.AddText(this.configRefBox, CreateHiveView.ConfigRefPlaceholder)
        this.AddPicker(this.registryModeBox, CreateHiveView.RegistryModePlaceholder, CreateHiveViewModel.Modes, this.vm.RegistryMode)
        this.AddText(this.endpointBox, CreateHiveView.EndpointPlaceholder)
        this.AddText(this.credentialRefBox, CreateHiveView.CredentialRefPlaceholder)
        this.AddText(this.trustRootRefBox, CreateHiveView.TrustRootRefPlaceholder)
        this.AddChild(this.MakeButton(PortalViewBase.CreateLabel, () => { void this.Submit() }))
        this.AddChild(this.MakeButton(PortalViewBase.BackLabel, () => { this.nav.ShowHives(clientId, tenantId) }))
        this.AddChild(this.message)
    }

    public async Refresh(): Promise<void>
    {
        // Static form: nothing to re-fetch.
    }

    private AddText(box: TextBox, placeholder: string): void
    {
        box.Placeholder = placeholder
        this.AddChild(box)
    }

    private AddPicker(box: ComboBox, placeholder: string, values: readonly string[], selected: string): void
    {
        box.Placeholder = placeholder
        box.DisplayMemberPath = CreateHiveView.LabelPath
        box.ItemsSource = values.map(v => new HiveOption(v, v))
        box.SelectedIndex = values.indexOf(selected)
        this.AddChild(box)
    }

    private Picked(box: ComboBox): string | undefined
    {
        return (box.SelectedItem as HiveOption | undefined)?.Value
    }

    private async Submit(): Promise<void>
    {
        this.vm.Id = this.idBox.Text
        this.vm.DisplayName = this.nameBox.Text
        this.vm.Backend = (this.Picked(this.backendBox) ?? this.vm.Backend) as HiveClusterBackend
        this.vm.ClusterMode = (this.Picked(this.clusterModeBox) ?? this.vm.ClusterMode) as HiveProvisionMode
        this.vm.ConfigRef = this.configRefBox.Text
        this.vm.RegistryMode = (this.Picked(this.registryModeBox) ?? this.vm.RegistryMode) as HiveProvisionMode
        this.vm.Endpoint = this.endpointBox.Text
        this.vm.CredentialRef = this.credentialRefBox.Text
        this.vm.TrustRootRef = this.trustRootRefBox.Text
        try
        {
            await this.vm.Submit()
        }
        catch (e)
        {
            this.ShowError(e)
            return
        }
        this.nav.ShowHives(this.clientId, this.tenantId)
    }
}
