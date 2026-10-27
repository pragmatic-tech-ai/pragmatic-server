import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { Steps } from './kit/index.js'
import { AdoptOutcome } from './releases-view-model.js'
import type { ReleasesViewModel } from './releases-view-model.js'

export interface AdoptWizardInputs
{
    vm: ReleasesViewModel
    version: string
    onClose: () => void
}

enum WizardStep
{
    Version,
    Environments,
    Review,
    RollOut,
    Outcome,
}

// A hive-wide Adopt wizard driven by the kit Steps strip. Environments are informational
// only (adopt applies to the whole hive). The outcome step reports exactly what the
// view model recorded, with the server message verbatim.
export class AdoptWizard extends StackPanel
{
    public static readonly TrustNote = 'If a new version fails verification, your environment keeps serving the version it runs now.'
    public static readonly RollingText = 'Rolling…'
    public static readonly AdoptedText = 'Adopted: the hive now targets this version.'
    public static readonly RefusedText = 'Adopt was refused.'
    public static readonly UnavailableText = 'Adopt is unavailable right now.'
    public static readonly UnknownText = 'The adopt could not be completed.'

    private static readonly StepLabels = ['Version', 'Environments', 'Review', 'Roll out', 'Outcome']
    private static readonly NextLabel = 'Next'
    private static readonly BackLabel = 'Back'
    private static readonly RollOutLabel = 'Roll out'
    private static readonly CloseLabel = 'Close'
    private static readonly VersionPrefix = 'Version: '
    private static readonly PublishedPrefix = 'Published: '
    private static readonly NotesPrefix = 'Notes: '
    private static readonly EnvSeparator = ' - '

    private readonly inputs: AdoptWizardInputs
    private readonly steps: Steps
    private readonly host: StackPanel
    private run: Promise<void> | undefined
    private done = false

    public constructor(inputs: AdoptWizardInputs)
    {
        super()
        this.inputs = inputs
        this.Orientation = Orientation.Vertical
        this.steps = new Steps({ labels: AdoptWizard.StepLabels, onChange: () => this.OnStepChanged() })
        this.host = new StackPanel()
        this.host.Orientation = Orientation.Vertical
        this.AddChild(this.steps)
        this.AddChild(this.host)
        this.RenderBody()
    }

    // Test seam: index of the current step.
    public get ActiveStep(): number
    {
        return this.steps.ActiveIndex
    }

    // Test seam: the panel holding the current step's body.
    public get ContentHost(): StackPanel
    {
        return this.host
    }

    // Test seam: settles when the Roll out step's adopt call has resolved and the wizard has advanced.
    public get Settled(): Promise<void>
    {
        return this.run ?? Promise.resolve()
    }

    public Next(): void
    {
        this.steps.Advance()
    }

    public Back(): void
    {
        this.steps.Back()
    }

    private OnStepChanged(): void
    {
        if (this.steps.ActiveIndex === WizardStep.RollOut && this.run === undefined)
        {
            this.run = this.RunAdopt()
        }
        this.RenderBody()
    }

    private async RunAdopt(): Promise<void>
    {
        try
        {
            await this.inputs.vm.ConfirmAdopt(this.inputs.version)
        }
        finally
        {
            this.done = true
            this.steps.Select(WizardStep.Outcome)
        }
    }

    private RenderBody(): void
    {
        for (const child of [...this.host.Children])
        {
            this.host.RemoveChild(child)
        }
        switch (this.steps.ActiveIndex as WizardStep)
        {
            case WizardStep.Version:
                this.BuildVersion()
                break
            case WizardStep.Environments:
                this.BuildEnvironments()
                break
            case WizardStep.Review:
                this.BuildReview()
                break
            case WizardStep.RollOut:
                this.AddText(AdoptWizard.RollingText)
                break
            case WizardStep.Outcome:
                this.BuildOutcome()
                break
        }
    }

    private BuildVersion(): void
    {
        const manifest = this.inputs.vm.Versions.find(r => r.version === this.inputs.version)?.manifest
        this.AddText(AdoptWizard.VersionPrefix + this.inputs.version)
        if (manifest?.publishedAt !== undefined)
        {
            this.AddText(AdoptWizard.PublishedPrefix + manifest.publishedAt)
        }
        if (manifest?.notes !== undefined)
        {
            this.AddText(AdoptWizard.NotesPrefix + manifest.notes)
        }
        this.AddButton(AdoptWizard.NextLabel, () => this.Next())
    }

    private BuildEnvironments(): void
    {
        for (const info of this.inputs.vm.EnvSteps(this.inputs.version))
        {
            this.AddText(info.environmentName + AdoptWizard.EnvSeparator + info.label)
        }
        this.AddButton(AdoptWizard.BackLabel, () => this.Back())
        this.AddButton(AdoptWizard.NextLabel, () => this.Next())
    }

    private BuildReview(): void
    {
        this.AddText(this.inputs.vm.Impact(this.inputs.version))
        this.AddText(AdoptWizard.TrustNote)
        this.AddButton(AdoptWizard.BackLabel, () => this.Back())
        this.AddButton(AdoptWizard.RollOutLabel, () => this.Next())
    }

    private BuildOutcome(): void
    {
        if (!this.done)
        {
            this.AddText(AdoptWizard.RollingText)
            return
        }
        const result = this.inputs.vm.LastResult
        switch (result?.outcome)
        {
            case AdoptOutcome.Adopted:
                this.AddText(AdoptWizard.AdoptedText)
                break
            case AdoptOutcome.Refused:
                this.AddText(AdoptWizard.RefusedText)
                this.AddMessage(result.message)
                break
            case AdoptOutcome.Unavailable:
                this.AddText(AdoptWizard.UnavailableText)
                this.AddMessage(result.message)
                break
            default:
                this.AddText(AdoptWizard.UnknownText)
                break
        }
        this.AddButton(AdoptWizard.CloseLabel, () => this.inputs.onClose())
    }

    private AddMessage(message: string | undefined): void
    {
        if (message !== undefined)
        {
            this.AddText(message)
        }
    }

    private AddText(text: string): void
    {
        const t = new TextBlock()
        t.Text = text
        this.host.AddChild(t)
    }

    private AddButton(label: string, onClick: () => void): void
    {
        const b = new Button()
        const t = new TextBlock()
        t.Text = label
        b.Content = t
        b.AddClickHandler(onClick)
        this.host.AddChild(b)
    }
}
