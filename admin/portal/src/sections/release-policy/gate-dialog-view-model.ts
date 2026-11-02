import { ObservableCollection } from '@pragmatic-tech-ai/mural/runtime'
import type { DialogService } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import { OptionViewModel } from '../../shell/option-view-model.js'
import { PortalDialogViewModel } from '../../shell/portal-dialog-view-model.js'
import type { PortalSessionService } from '../../shell/portal-session-service.js'
import { VersionOrder } from '../../version-order.js'
import { PolicyOwnerLabels } from './policy-owner-labels.js'

// Gate a version for a tenant: allows the tenant's hives to adopt it, subject
// to the tenant's release policy. Offers every tenant and every version that
// is not withdrawn, newest first.
export class GateDialogViewModel extends PortalDialogViewModel<boolean>
{
    private static readonly SelectedTenantProperty = 'SelectedTenant'
    private static readonly SelectedVersionProperty = 'SelectedVersion'
    private static readonly Gated = true

    private readonly tenants = new ObservableCollection<OptionViewModel<string>>()
    private readonly versions = new ObservableCollection<OptionViewModel<string>>()
    private selectedTenant: OptionViewModel<string> | undefined
    private selectedVersion: OptionViewModel<string> | undefined

    public constructor(session: PortalSessionService, dialogs: DialogService)
    {
        super(session, dialogs)
    }

    public override async Load(): Promise<void>
    {
        const api = this.Session.Client
        const [tenants, clients, manifests] = await Promise.all([api.ListTenants(), api.ListClients(), api.ListManifests()])
        const labels = new PolicyOwnerLabels(tenants, clients)
        this.tenants.Clear()
        for (const tenant of [...tenants].sort((a, b) => labels.For(a.id).localeCompare(labels.For(b.id))))
        {
            this.tenants.Add(new OptionViewModel(tenant.id, labels.For(tenant.id)))
        }
        this.versions.Clear()
        const adoptable = manifests.filter(m => m.withdrawn !== true).sort((a, b) => VersionOrder.Compare(b.id, a.id))
        for (const manifest of adoptable)
        {
            this.versions.Add(new OptionViewModel(manifest.id, manifest.id))
        }
    }

    public get Tenants(): ObservableCollection<OptionViewModel<string>>
    {
        return this.tenants
    }

    public get SelectedTenant(): OptionViewModel<string> | undefined
    {
        return this.selectedTenant
    }

    public set SelectedTenant(value: OptionViewModel<string> | undefined)
    {
        this.SetField(GateDialogViewModel.SelectedTenantProperty, this.selectedTenant, value, v => { this.selectedTenant = v })
    }

    public get Versions(): ObservableCollection<OptionViewModel<string>>
    {
        return this.versions
    }

    public get SelectedVersion(): OptionViewModel<string> | undefined
    {
        return this.selectedVersion
    }

    public set SelectedVersion(value: OptionViewModel<string> | undefined)
    {
        this.SetField(GateDialogViewModel.SelectedVersionProperty, this.selectedVersion, value, v => { this.selectedVersion = v })
    }

    protected override get CanConfirm(): boolean
    {
        return this.selectedTenant !== undefined && this.selectedVersion !== undefined
    }

    protected override async SubmitCore(): Promise<boolean>
    {
        const tenant = this.selectedTenant
        const version = this.selectedVersion
        if (tenant === undefined || version === undefined)
        {
            return false
        }
        await this.Session.Client.Gate(tenant.Value, version.Value)
        return GateDialogViewModel.Gated
    }
}
