import { Orientation, StackPanel, TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { ConfirmDialog, ConfirmTone } from './kit/confirm-dialog.js'
import { OnceSecret } from './kit/once-secret.js'
import { SecretTable } from './kit/secret-table.js'
import type { SecretRow } from './kit/secret-table.js'
import { ServiceTokensViewModel, TokenDuration, TokensState } from './service-tokens-view-model.js'
import type { ITokensSource } from './tenant-types.js'
import { TenantViewBase } from './tenant-view-base.js'

// Tenant admin "Service Tokens": environment picker, a by-reference SecretTable with a
// per-row Revoke (confirmed through a kit dialog), the issue form, and a one-time OnceSecret reveal.
export class ServiceTokensView extends TenantViewBase
{
    public static readonly SelectedMark = '\u25cf '
    public static readonly LoadingText = 'Loading tokens...'
    public static readonly EmptyText = 'No service tokens yet.'
    public static readonly NoEnvironmentText = 'No environments available.'
    public static readonly PrincipalPlaceholder = 'Principal id'
    public static readonly ScopesPlaceholder = 'space- or comma-separated scopes'
    public static readonly IssueHeading = 'Issue token'
    public static readonly IssueLabel = 'Issue'
    public static readonly OwnerPrefix = 'Owner: '
    public static readonly RevokeNeed = 'the Manage users & access permission'
    public static readonly RevokeTitle = 'Revoke service token'
    public static readonly RevokeBody = 'This token stops working immediately. Anything using it will start failing.'
    public static readonly RevokeActionLabel = 'Revoke token'
    public static readonly RevealTitle = 'API token'
    public static readonly RevealHint = 'Copy it now. It will not be shown again.'
    public static readonly OneHourLabel = '1 hour'
    public static readonly OneDayLabel = '1 day'
    public static readonly ThirtyDaysLabel = '30 days'
    public static readonly NeverLabel = 'Never expires'

    private static readonly Durations: ReadonlyMap<TokenDuration, string> = new Map<TokenDuration, string>([
        [TokenDuration.OneHour, ServiceTokensView.OneHourLabel],
        [TokenDuration.OneDay, ServiceTokensView.OneDayLabel],
        [TokenDuration.ThirtyDays, ServiceTokensView.ThirtyDaysLabel],
        [TokenDuration.Never, ServiceTokensView.NeverLabel],
    ])

    private readonly vm: ServiceTokensViewModel
    private readonly principalBox = new TextBox()
    private readonly scopesBox = new TextBox()
    private readonly durationStrip = new StackPanel()
    private readonly form = new StackPanel()
    private readonly dialogHost = new StackPanel()
    private table: SecretTable | undefined
    private reveal: OnceSecret | undefined
    private revealOf: unknown
    private dialog: ConfirmDialog | undefined
    private dialogRef: string | undefined

    public constructor(source: ITokensSource)
    {
        super()
        this.vm = new ServiceTokensViewModel(source)
        this.BuildForm()
        this.AddChild(this.dialogHost)
        const rerender = (): void => this.Render()
        this.vm.PropertyChanged(ServiceTokensViewModel.RowsProperty).subscribe(rerender)
        this.vm.PropertyChanged(ServiceTokensViewModel.EnvironmentsProperty).subscribe(rerender)
        this.vm.PropertyChanged(ServiceTokensViewModel.SelectedEnvironmentProperty).subscribe(rerender)
        this.vm.PropertyChanged(ServiceTokensViewModel.StateProperty).subscribe(rerender)
        this.vm.PropertyChanged(ServiceTokensViewModel.ErrorProperty).subscribe(rerender)
        this.vm.PropertyChanged(ServiceTokensViewModel.PendingProperty).subscribe(rerender)
        this.vm.PropertyChanged(ServiceTokensViewModel.IssuedSecretProperty).subscribe(rerender)
        this.Render()
    }

    // Test seam: the by-reference token list (Ready state only).
    public get Table(): SecretTable | undefined
    {
        return this.table
    }

    // Test seam: the one-time secret reveal, while an issued secret is held.
    public get Reveal(): OnceSecret | undefined
    {
        return this.reveal
    }

    // Test seam: the hosted revoke confirm, if one is open.
    public get ActiveConfirm(): ConfirmDialog | undefined
    {
        return this.dialog
    }

    public async Refresh(): Promise<void>
    {
        await this.Act(() => this.vm.LoadEnvironments())
    }

    public Dispose(): void
    {
        this.vm.DismissSecret()
        this.vm.CancelPending()
    }

    public Render(): void
    {
        this.SyncDialog()
        for (const child of [...this.Children])
        {
            if (child !== this.dialogHost)
            {
                this.RemoveChild(child)
            }
        }
        const vm = this.vm
        this.table = undefined
        this.AddChild(this.MakeEnvironmentStrip())
        this.message.Text = vm.Error
        this.AddChild(this.message)
        switch (vm.State)
        {
            case TokensState.Ready:
                this.table = this.MakeTable()
                this.AddChild(this.table)
                break
            case TokensState.Loading:
                this.AddChild(this.Text(ServiceTokensView.LoadingText))
                break
            case TokensState.Empty:
                this.AddChild(this.Text(ServiceTokensView.EmptyText))
                break
            case TokensState.NoEnvironment:
                this.AddChild(this.Text(ServiceTokensView.NoEnvironmentText))
                break
            case TokensState.Error:
                break
        }
        this.SyncReveal()
        if (this.reveal !== undefined)
        {
            this.AddChild(this.reveal)
        }
        if (vm.SelectedEnvironment !== undefined)
        {
            this.RefreshDurationStrip()
            this.AddChild(this.form)
        }
        this.SyncDialogHost()
    }

    private get CanRevoke(): boolean
    {
        return this.Navigator?.Capabilities?.access !== false
    }

    private MakeTable(): SecretTable
    {
        const rows: SecretRow[] = this.vm.Rows.map(r => ({
            reference: r.TokenRef,
            note: ServiceTokensView.OwnerPrefix + r.PrincipalId,
            status: r.PillKind,
            revoked: r.Revoked,
        }))
        return new SecretTable({
            rows,
            canRevoke: this.CanRevoke,
            need: ServiceTokensView.RevokeNeed,
            onRevoke: ref => this.vm.RequestRevoke(ref),
        })
    }

    // The reveal is kept per issued secret so re-renders do not rebuild a cleared box.
    private SyncReveal(): void
    {
        const issued = this.vm.IssuedSecret
        if (issued === undefined)
        {
            this.reveal = undefined
            this.revealOf = undefined
            return
        }
        if (this.revealOf === issued && this.reveal !== undefined)
        {
            return
        }
        this.revealOf = issued
        this.reveal = new OnceSecret({
            title: ServiceTokensView.RevealTitle,
            value: issued.token,
            hint: ServiceTokensView.RevealHint,
            onDone: () => this.vm.DismissSecret(),
        })
    }

    // The dialog follows vm.Pending: one instance per pending ref, dropped when it clears.
    private SyncDialog(): void
    {
        const pending = this.vm.Pending
        if (pending === undefined)
        {
            this.dialog = undefined
            this.dialogRef = undefined
            return
        }
        if (this.dialog !== undefined && this.dialogRef === pending)
        {
            return
        }
        this.dialogRef = pending
        this.dialog = new ConfirmDialog({
            title: ServiceTokensView.RevokeTitle,
            body: ServiceTokensView.RevokeBody,
            actionLabel: ServiceTokensView.RevokeActionLabel,
            tone: ConfirmTone.Danger,
            onConfirm: () => { void this.Act(() => this.vm.ConfirmPending()) },
            onClose: () => this.vm.CancelPending(),
        })
    }

    // The dialog lives in a host that is a permanent child, outside the rebuilt subtree.
    private SyncDialogHost(): void
    {
        const hosted = [...this.dialogHost.Children]
        if (hosted.length === 1 && hosted[0] === this.dialog)
        {
            return
        }
        for (const child of hosted)
        {
            this.dialogHost.RemoveChild(child)
        }
        if (this.dialog !== undefined)
        {
            this.dialogHost.AddChild(this.dialog)
        }
    }

    private BuildForm(): void
    {
        this.principalBox.Placeholder = ServiceTokensView.PrincipalPlaceholder
        this.scopesBox.Placeholder = ServiceTokensView.ScopesPlaceholder
        this.durationStrip.Orientation = Orientation.Horizontal
        this.RefreshDurationStrip()
        this.form.AddChild(this.Text(ServiceTokensView.IssueHeading))
        this.form.AddChild(this.principalBox)
        this.form.AddChild(this.scopesBox)
        this.form.AddChild(this.durationStrip)
        this.form.AddChild(this.MakeButton(ServiceTokensView.IssueLabel, () => { void this.Act(() => this.Issue()) }))
    }

    // Duration buttons are rebuilt in place so the selected mark follows the VM draft.
    private RefreshDurationStrip(): void
    {
        for (const child of [...this.durationStrip.Children])
        {
            this.durationStrip.RemoveChild(child)
        }
        for (const [duration, name] of ServiceTokensView.Durations)
        {
            const label = duration === this.vm.DraftDuration ? ServiceTokensView.SelectedMark + name : name
            this.durationStrip.AddChild(this.MakeButton(label, () => { this.vm.DraftDuration = duration; this.Render() }))
        }
    }

    // Runs a view-model call; failures surface through ShowError (401 drops to login).
    private async Act(action: () => Promise<unknown>): Promise<void>
    {
        try
        {
            await action()
        }
        catch (e)
        {
            this.ShowError(e)
        }
    }

    private MakeEnvironmentStrip(): StackPanel
    {
        const strip = new StackPanel()
        strip.Orientation = Orientation.Horizontal
        for (const name of this.vm.Environments)
        {
            const label = name === this.vm.SelectedEnvironment ? ServiceTokensView.SelectedMark + name : name
            strip.AddChild(this.MakeButton(label, () => { void this.Act(() => this.vm.SelectEnvironment(name)) }))
        }
        return strip
    }

    private async Issue(): Promise<void>
    {
        const vm = this.vm
        vm.DraftPrincipalId = this.principalBox.Text
        vm.DraftScopes = this.scopesBox.Text
        await vm.IssueToken()
        // The VM clears each draft only on success, so the boxes follow it.
        this.principalBox.Text = vm.DraftPrincipalId
        this.scopesBox.Text = vm.DraftScopes
    }

    private Text(text: string): TextBlock
    {
        const t = new TextBlock()
        t.Text = text
        return t
    }
}
