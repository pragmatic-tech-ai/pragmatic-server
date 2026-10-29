import { Orientation, StackPanel, TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { ComboBox } from '@pragmatic-tech-ai/mural/framework'
import { ApiError } from './api-client.js'
import type { ControlPlaneClient } from './api-client.js'
import { CreateHiveViewModel } from './create-hive-view-model.js'
import type { OperatorContext } from './operator-context.js'
import type { HiveClusterBackend, HiveProvisionMode } from './portal-types.js'
import { ProvisionWizardViewModel, WizardStep } from './provision-wizard-view-model.js'
import { Act, ActVariant, ComboOption, KeyActivatedButton, OnceSecret, Steps } from './kit/index.js'

export enum WizardViewMode
{
    Form,
    Reveal
}

// One field's box-to-VM binding. The box is copied into the VM only when the user changed it since the
// box was built, so values set directly on the VM are never clobbered by a stale (untouched) box.
class FieldBinding
{
    private readonly initial: string

    public constructor(private readonly read: () => string, private readonly write: (value: string) => void)
    {
        this.initial = read()
    }

    public Sync(): void
    {
        const current = this.read()
        if (current !== this.initial)
        {
            this.write(current)
        }
    }
}

// Multi-step provisioning wizard (client -> tenant -> hive). On success the one-time secrets go straight
// into OnceSecret reveal Visuals; the view keeps no copy of them.
export class ProvisionWizardView extends StackPanel
{
    private static readonly StepLabels: readonly string[] = ['Client', 'Tenant', 'Hive']
    private static readonly LastStep = WizardStep.Hive
    private static readonly FirstStep = WizardStep.Client
    private static readonly LabelPath = 'Label'
    private static readonly ClientIdPlaceholder = 'Client id'
    private static readonly ClientNamePlaceholder = 'Client display name'
    private static readonly SubscriptionRefPlaceholder = 'Subscription ref (optional)'
    private static readonly TenantIdPlaceholder = 'Tenant id'
    private static readonly TenantNamePlaceholder = 'Tenant display name'
    private static readonly OwnerEmailPlaceholder = 'Owner email'
    private static readonly HiveIdPlaceholder = 'Hive id'
    private static readonly HiveNamePlaceholder = 'Hive display name'
    private static readonly BackendPlaceholder = 'Cluster backend'
    private static readonly ClusterModePlaceholder = 'Cluster mode'
    private static readonly ConfigRefPlaceholder = 'Cluster config ref (optional)'
    private static readonly RegistryModePlaceholder = 'Registry mode'
    private static readonly EndpointPlaceholder = 'Registry endpoint (optional)'
    private static readonly CredentialRefPlaceholder = 'Registry credential ref (optional)'
    private static readonly TrustRootRefPlaceholder = 'Trust root ref (optional)'
    private static readonly BackLabel = 'Back'
    private static readonly NextLabel = 'Next'
    private static readonly ProvisionLabel = 'Provision'
    private static readonly FinishLabel = 'Finish'
    private static readonly RevealIntro = 'Provisioned. These secrets are shown once and cannot be retrieved later. Save each one, then confirm.'
    private static readonly OwnerPasswordLabel = 'Owner password'
    private static readonly AgentTokenLabel = 'Agent token'
    private static readonly OwnerConfirmLabel = 'I have saved the owner password'
    private static readonly AgentConfirmLabel = 'I have saved the agent token'
    private static readonly ErrorPrefix = 'Provisioning failed: '
    private static readonly RolledBackHeading = 'Rolled back:'
    private static readonly ResidueHeading = 'Residue (needs manual cleanup):'
    private static readonly ItemPrefix = ' - '

    private readonly vm: ProvisionWizardViewModel
    private readonly content = new StackPanel()
    private readonly errors = new StackPanel()
    private mode = WizardViewMode.Form
    private step = ProvisionWizardView.FirstStep
    private bindings: FieldBinding[] = []
    private submitAct: Act | undefined
    private nextButton: KeyActivatedButton | undefined
    private reveals: OnceSecret[] = []
    private finishAct: Act | undefined
    private submitting = false

    public constructor(client: ControlPlaneClient, private readonly operator: OperatorContext, private readonly onDone: () => void)
    {
        super()
        this.vm = new ProvisionWizardViewModel(client)
        this.Orientation = Orientation.Vertical
        this.AddChild(this.content)
        this.AddChild(this.errors)
        this.RenderForm()
    }

    // Test seam: the form state.
    public get Model(): ProvisionWizardViewModel
    {
        return this.vm
    }

    public get Mode(): WizardViewMode
    {
        return this.mode
    }

    // Test seam: the last-step provision action (undefined on earlier steps and in reveal mode).
    public get SubmitAct(): Act | undefined
    {
        return this.submitAct
    }

    // Test seam: the Next button (undefined on the last step and in reveal mode).
    public get NextButton(): KeyActivatedButton | undefined
    {
        return this.nextButton
    }

    // Test seam: the live reveals (empty outside reveal mode).
    public get Reveals(): OnceSecret[]
    {
        return this.reveals
    }

    // Test seam: the Finish action (undefined outside reveal mode).
    public get FinishAct(): Act | undefined
    {
        return this.finishAct
    }

    private ClearContent(): void
    {
        for (const child of [...this.content.Children])
        {
            this.content.RemoveChild(child)
        }
        this.bindings = []
        this.submitAct = undefined
        this.nextButton = undefined
        this.finishAct = undefined
        this.reveals = []
    }

    private RenderForm(): void
    {
        this.ClearContent()
        this.content.AddChild(new Steps({ steps: ProvisionWizardView.StepLabels, current: this.step, content: this.BuildStep() }))
    }

    private BuildStep(): StackPanel
    {
        const panel = new StackPanel()
        panel.Orientation = Orientation.Vertical
        const vm = this.vm
        switch (this.step)
        {
            case WizardStep.Client:
                this.AddText(panel, ProvisionWizardView.ClientIdPlaceholder, () => vm.ClientId, v => { vm.ClientId = v })
                this.AddText(panel, ProvisionWizardView.ClientNamePlaceholder, () => vm.ClientDisplayName, v => { vm.ClientDisplayName = v })
                this.AddText(panel, ProvisionWizardView.SubscriptionRefPlaceholder, () => vm.SubscriptionRef, v => { vm.SubscriptionRef = v })
                break
            case WizardStep.Tenant:
                this.AddText(panel, ProvisionWizardView.TenantIdPlaceholder, () => vm.TenantId, v => { vm.TenantId = v })
                this.AddText(panel, ProvisionWizardView.TenantNamePlaceholder, () => vm.TenantDisplayName, v => { vm.TenantDisplayName = v })
                this.AddText(panel, ProvisionWizardView.OwnerEmailPlaceholder, () => vm.OwnerEmail, v => { vm.OwnerEmail = v })
                break
            default:
                this.AddText(panel, ProvisionWizardView.HiveIdPlaceholder, () => vm.HiveId, v => { vm.HiveId = v })
                this.AddText(panel, ProvisionWizardView.HiveNamePlaceholder, () => vm.HiveDisplayName, v => { vm.HiveDisplayName = v })
                this.AddPicker(panel, ProvisionWizardView.BackendPlaceholder, CreateHiveViewModel.Backends, () => vm.Backend, v => { vm.Backend = v as HiveClusterBackend })
                this.AddPicker(panel, ProvisionWizardView.ClusterModePlaceholder, CreateHiveViewModel.Modes, () => vm.ClusterMode, v => { vm.ClusterMode = v as HiveProvisionMode })
                this.AddText(panel, ProvisionWizardView.ConfigRefPlaceholder, () => vm.ConfigRef, v => { vm.ConfigRef = v })
                this.AddPicker(panel, ProvisionWizardView.RegistryModePlaceholder, CreateHiveViewModel.Modes, () => vm.RegistryMode, v => { vm.RegistryMode = v as HiveProvisionMode })
                this.AddText(panel, ProvisionWizardView.EndpointPlaceholder, () => vm.Endpoint, v => { vm.Endpoint = v })
                this.AddText(panel, ProvisionWizardView.CredentialRefPlaceholder, () => vm.CredentialRef, v => { vm.CredentialRef = v })
                this.AddText(panel, ProvisionWizardView.TrustRootRefPlaceholder, () => vm.TrustRootRef, v => { vm.TrustRootRef = v })
                break
        }
        panel.AddChild(this.BuildNav())
        return panel
    }

    private BuildNav(): StackPanel
    {
        const nav = new StackPanel()
        nav.Orientation = Orientation.Horizontal
        if (this.step !== ProvisionWizardView.FirstStep)
        {
            nav.AddChild(this.MakeButton(ProvisionWizardView.BackLabel, () => { this.GoBack() }))
        }
        if (this.step === ProvisionWizardView.LastStep)
        {
            this.submitAct = new Act(this.operator.MutatingAct(ProvisionWizardView.ProvisionLabel, () => { void this.Submit() }, ActVariant.Primary))
            nav.AddChild(this.submitAct)
        }
        else
        {
            this.nextButton = this.MakeButton(ProvisionWizardView.NextLabel, () => { this.GoNext() })
            nav.AddChild(this.nextButton)
        }
        return nav
    }

    private MakeButton(label: string, onClick: () => void): KeyActivatedButton
    {
        const button = new KeyActivatedButton(onClick)
        const text = new TextBlock()
        text.Text = label
        button.Content = text
        return button
    }

    private AddText(panel: StackPanel, placeholder: string, read: () => string, write: (value: string) => void): void
    {
        const box = new TextBox()
        box.Placeholder = placeholder
        box.Text = read()
        this.bindings.push(new FieldBinding(() => box.Text, write))
        panel.AddChild(box)
    }

    private AddPicker(panel: StackPanel, placeholder: string, values: readonly string[], read: () => string, write: (value: string) => void): void
    {
        const box = new ComboBox()
        box.Placeholder = placeholder
        box.DisplayMemberPath = ProvisionWizardView.LabelPath
        box.ItemsSource = values.map(v => new ComboOption(v, v))
        box.SelectedIndex = values.indexOf(read())
        this.bindings.push(new FieldBinding(() => (box.SelectedItem as ComboOption | undefined)?.Value ?? read(), write))
        panel.AddChild(box)
    }

    private SyncFields(): void
    {
        for (const binding of this.bindings)
        {
            binding.Sync()
        }
    }

    private GoNext(): void
    {
        this.SyncFields()
        if (!this.vm.StepValid(this.step))
        {
            return
        }
        this.step++
        this.RenderForm()
    }

    private GoBack(): void
    {
        this.SyncFields()
        if (this.step > ProvisionWizardView.FirstStep)
        {
            this.step--
            this.RenderForm()
        }
    }

    private async Submit(): Promise<void>
    {
        if (this.submitting)
        {
            return
        }
        this.submitting = true
        const act = this.submitAct
        if (act !== undefined)
        {
            act.IsEnabled = false
        }
        this.SyncFields()
        this.ClearErrors()
        let result
        try
        {
            result = await this.vm.Provision()
        }
        catch (e)
        {
            this.submitting = false
            if (act !== undefined)
            {
                act.IsEnabled = true
            }
            this.ShowFailure(e)
            return
        }
        this.submitting = false
        // The secrets go straight into the reveal Visuals; nothing on the view keeps them.
        this.mode = WizardViewMode.Reveal
        this.ClearContent()
        this.content.AddChild(this.BuildReveal(result.secrets.ownerPassword, result.secrets.agentToken))
    }

    private BuildReveal(ownerPassword: string, agentToken: string): StackPanel
    {
        const panel = new StackPanel()
        panel.Orientation = Orientation.Vertical
        const intro = new TextBlock()
        intro.Text = ProvisionWizardView.RevealIntro
        panel.AddChild(intro)
        this.reveals = [
            this.MakeReveal(ProvisionWizardView.OwnerPasswordLabel, ownerPassword, ProvisionWizardView.OwnerConfirmLabel),
            this.MakeReveal(ProvisionWizardView.AgentTokenLabel, agentToken, ProvisionWizardView.AgentConfirmLabel)
        ]
        for (const reveal of this.reveals)
        {
            panel.AddChild(reveal)
        }
        this.finishAct = new Act(this.operator.MutatingAct(ProvisionWizardView.FinishLabel, () => { this.Finish() }, ActVariant.Primary))
        this.finishAct.IsEnabled = false
        panel.AddChild(this.finishAct)
        return panel
    }

    private MakeReveal(label: string, value: string, confirmLabel: string): OnceSecret
    {
        return new OnceSecret({ label, value, confirmLabel, onConfirm: () => { this.OnRevealConfirmed() } })
    }

    private AllConfirmed(): boolean
    {
        return this.reveals.length > 0 && this.reveals.every(r => r.Confirmed)
    }

    private OnRevealConfirmed(): void
    {
        if (this.finishAct !== undefined)
        {
            this.finishAct.IsEnabled = this.AllConfirmed() && this.operator.CanMutate
        }
    }

    private Finish(): void
    {
        if (this.AllConfirmed())
        {
            this.onDone()
        }
    }

    private ClearErrors(): void
    {
        for (const child of [...this.errors.Children])
        {
            this.errors.RemoveChild(child)
        }
    }

    private ShowFailure(e: unknown): void
    {
        this.AddError(ProvisionWizardView.ErrorPrefix + (e instanceof Error ? e.message : String(e)))
        if (e instanceof ApiError && e.rollback !== undefined)
        {
            this.AddReportLines(ProvisionWizardView.RolledBackHeading, e.rollback.rolledBack)
            this.AddReportLines(ProvisionWizardView.ResidueHeading, e.rollback.residue)
        }
    }

    private AddReportLines(heading: string, items: readonly string[]): void
    {
        if (items.length === 0)
        {
            return
        }
        this.AddError(heading)
        for (const item of items)
        {
            this.AddError(ProvisionWizardView.ItemPrefix + item)
        }
    }

    private AddError(text: string): void
    {
        const line = new TextBlock()
        line.Text = text
        this.errors.AddChild(line)
    }
}
