import { Orientation, StackPanel, TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { GridLength, GridUnitType } from '@pragmatic-tech-ai/mural/basic/panels/grid.js'
import { DataGrid } from '@pragmatic-tech-ai/mural/framework/data-grid/data-grid.js'
import { DataGridTextColumn } from '@pragmatic-tech-ai/mural/framework/data-grid/data-grid-column.js'
import { SelectionMode } from '@pragmatic-tech-ai/mural/framework/list/selector.js'
import type { ServiceTokenRow } from './service-token-row.js'
import { ServiceTokensViewModel, TokenDuration, TokensState } from './service-tokens-view-model.js'
import type { ITokensSource, TokenIssuedDto } from './tenant-types.js'
import { TenantViewBase } from './tenant-view-base.js'

// Tenant admin "Service Tokens": environment picker, tokens DataGrid, issue form,
// revoke action for the selected row, and a one-time secret reveal panel.
export class ServiceTokensView extends TenantViewBase
{
    public static readonly TokenRefHeader = 'Token'
    public static readonly PrincipalHeader = 'Principal'
    public static readonly ScopesHeader = 'Scopes'
    public static readonly ExpiresHeader = 'Expires'
    public static readonly StatusHeader = 'Status'
    public static readonly TokenRefPath = 'TokenRef'
    public static readonly PrincipalPath = 'PrincipalId'
    public static readonly ScopesPath = 'ScopesText'
    public static readonly ExpiresPath = 'ExpiresText'
    public static readonly StatusPath = 'StatusText'
    public static readonly SelectedMark = '● '
    public static readonly LoadingText = 'Loading tokens...'
    public static readonly EmptyText = 'No service tokens yet.'
    public static readonly NoEnvironmentText = 'No environments available.'
    public static readonly PrincipalPlaceholder = 'Principal id'
    public static readonly ScopesPlaceholder = 'space- or comma-separated scopes'
    public static readonly IssueHeading = 'Issue token'
    public static readonly IssueLabel = 'Issue'
    public static readonly RevokeLabel = 'Revoke'
    public static readonly ConfirmRevokeLabel = 'Confirm revoke'
    public static readonly CancelLabel = 'Cancel'
    public static readonly SelectedHeading = 'Selected token: '
    public static readonly RevealHeading = 'Token issued. Copy it now; it will not be shown again.'
    public static readonly DismissLabel = 'Dismiss'
    public static readonly RefLabel = 'Token ref: '
    public static readonly PrincipalLabel = 'Principal: '
    public static readonly ExpiresLabel = 'Expires: '
    public static readonly NeverText = 'Never'
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
    private readonly grid = new DataGrid()
    private readonly principalBox = new TextBox()
    private readonly scopesBox = new TextBox()
    private readonly durationStrip = new StackPanel()
    private readonly form = new StackPanel()
    private suppressSelection = false
    private readonly selectionListener = (): void =>
    {
        if (!this.suppressSelection)
        {
            // A pending revoke belongs to one row; selecting another row drops it.
            const pending = this.vm.Pending
            if (pending !== undefined && this.SelectedRow()?.TokenRef !== pending)
            {
                this.vm.CancelPending()
            }
            this.Render()
        }
    }

    public constructor(source: ITokensSource)
    {
        super()
        this.vm = new ServiceTokensViewModel(source)
        this.BuildGrid()
        this.BuildForm()
        const rerender = (): void => this.Render()
        this.vm.PropertyChanged(ServiceTokensViewModel.RowsProperty).subscribe(() =>
        {
            this.UpdateGrid()
            this.Render()
        })
        this.vm.PropertyChanged(ServiceTokensViewModel.EnvironmentsProperty).subscribe(rerender)
        this.vm.PropertyChanged(ServiceTokensViewModel.SelectedEnvironmentProperty).subscribe(rerender)
        this.vm.PropertyChanged(ServiceTokensViewModel.StateProperty).subscribe(rerender)
        this.vm.PropertyChanged(ServiceTokensViewModel.ErrorProperty).subscribe(rerender)
        this.vm.PropertyChanged(ServiceTokensViewModel.PendingProperty).subscribe(rerender)
        this.vm.PropertyChanged(ServiceTokensViewModel.IssuedSecretProperty).subscribe(rerender)
        this.Render()
    }

    // Test seam: the tokens grid.
    public get Grid(): DataGrid
    {
        return this.grid
    }

    public async Refresh(): Promise<void>
    {
        await this.Act(() => this.vm.LoadEnvironments())
    }

    public Dispose(): void
    {
        this.vm.DismissSecret()
        this.grid.RemoveSelectionChangedListener(this.selectionListener)
        this.grid.dispose()
    }

    public Render(): void
    {
        for (const child of [...this.Children])
        {
            this.RemoveChild(child)
        }
        const vm = this.vm
        this.AddChild(this.MakeEnvironmentStrip())
        this.message.Text = vm.Error
        this.AddChild(this.message)
        switch (vm.State)
        {
            case TokensState.Ready:
                this.AddChild(this.grid)
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
        const selected = this.SelectedRow()
        if (vm.State === TokensState.Ready && selected !== undefined)
        {
            this.AddChild(this.MakeSelectedSection(selected.TokenRef))
        }
        const issued = vm.IssuedSecret
        if (issued !== undefined)
        {
            this.AddChild(this.MakeRevealPanel(issued))
        }
        if (vm.SelectedEnvironment !== undefined)
        {
            this.RefreshDurationStrip()
            this.AddChild(this.form)
        }
    }

    private SelectedRow(): ServiceTokenRow | undefined
    {
        return this.grid.SelectedItem as ServiceTokenRow | undefined
    }

    private BuildGrid(): void
    {
        this.AddColumn(ServiceTokensView.TokenRefHeader, ServiceTokensView.TokenRefPath, new GridLength(3, GridUnitType.Star))
        this.AddColumn(ServiceTokensView.PrincipalHeader, ServiceTokensView.PrincipalPath, new GridLength(2, GridUnitType.Star))
        this.AddColumn(ServiceTokensView.ScopesHeader, ServiceTokensView.ScopesPath, new GridLength(3, GridUnitType.Star))
        this.AddColumn(ServiceTokensView.ExpiresHeader, ServiceTokensView.ExpiresPath, GridLength.Auto)
        this.AddColumn(ServiceTokensView.StatusHeader, ServiceTokensView.StatusPath, GridLength.Auto)
        this.grid.SelectionMode = SelectionMode.Single
        this.grid.AddSelectionChangedListener(this.selectionListener)
    }

    private AddColumn(header: string, path: string, width: GridLength): void
    {
        const col = new DataGridTextColumn()
        col.Header = header
        col.BindingPath = path
        col.Width = width
        this.grid.Columns.Add(col)
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

    private UpdateGrid(): void
    {
        // Replacing ItemsSource resets the grid selection; re-select the same token without echoing back.
        const previous = this.SelectedRow()?.TokenRef
        this.suppressSelection = true
        try
        {
            this.grid.ItemsSource = [...this.vm.Rows]
            this.grid.SelectedItem = previous === undefined ? undefined : this.vm.Rows.find(r => r.TokenRef === previous)
        }
        finally
        {
            this.suppressSelection = false
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

    private MakeSelectedSection(tokenRef: string): StackPanel
    {
        const vm = this.vm
        const section = new StackPanel()
        section.AddChild(this.Text(ServiceTokensView.SelectedHeading + tokenRef))
        if (vm.Pending === tokenRef)
        {
            const strip = new StackPanel()
            strip.Orientation = Orientation.Horizontal
            strip.AddChild(this.MakeButton(ServiceTokensView.ConfirmRevokeLabel, () => { void this.Act(() => vm.ConfirmPending()) }))
            strip.AddChild(this.MakeButton(ServiceTokensView.CancelLabel, () => vm.CancelPending()))
            section.AddChild(strip)
        }
        else
        {
            section.AddChild(this.MakeButton(ServiceTokensView.RevokeLabel, () => vm.RequestRevoke(tokenRef)))
        }
        return section
    }

    // The only place the secret is rendered; built fresh per Render and gone once dismissed.
    private MakeRevealPanel(issued: TokenIssuedDto): StackPanel
    {
        const panel = new StackPanel()
        panel.AddChild(this.Text(ServiceTokensView.RevealHeading))
        const secret = new TextBox()
        secret.IsReadOnly = true
        secret.Text = issued.token
        panel.AddChild(secret)
        panel.AddChild(this.Text(ServiceTokensView.RefLabel + issued.tokenRef))
        panel.AddChild(this.Text(ServiceTokensView.PrincipalLabel + issued.principalId))
        panel.AddChild(this.Text(ServiceTokensView.ExpiresLabel + (issued.expiresAt === null ? ServiceTokensView.NeverText : issued.expiresAt)))
        panel.AddChild(this.MakeButton(ServiceTokensView.DismissLabel, () => this.vm.DismissSecret()))
        return panel
    }

    private Text(text: string): TextBlock
    {
        const t = new TextBlock()
        t.Text = text
        return t
    }
}
