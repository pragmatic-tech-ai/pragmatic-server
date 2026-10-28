import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { Act, PillKind, Section, StatusPill } from './kit/index.js'
import { ConnectionState, ConnectionStatusViewModel } from './connection-status-view-model.js'
import type { IConnectionSource } from './tenant-types.js'

// Compact Overview card: is Pragmatic reachable from the hive. Reuses ConnectionStatusViewModel
// wholesale (no duplicated state mapping); a quiet link is shown honestly, not as an error.
export class OverviewConnectionCard extends StackPanel
{
    public static readonly Title = 'Connection'
    public static readonly ViewLabel = 'View connection status'
    public static readonly LoadingText = 'Checking the connection to Pragmatic...'
    public static readonly NoHiveText = 'No hive yet. Connect a hive to see its connection status.'
    public static readonly ForbiddenText = 'Connection status is not available to you.'
    public static readonly ErrorText = 'Could not load the connection status.'

    private readonly vm: ConnectionStatusViewModel
    private readonly subscriptions: IDisposable[] = []
    private readonly bodySlot = new StackPanel()
    private pill: StatusPill | undefined
    private detail: string | undefined
    private loadPromise: Promise<void> | undefined

    public constructor(source: IConnectionSource, private readonly onView: () => void)
    {
        super()
        this.vm = new ConnectionStatusViewModel(source)
        this.Orientation = Orientation.Vertical
        this.bodySlot.Orientation = Orientation.Vertical
        for (const name of [ConnectionStatusViewModel.StateProperty, ConnectionStatusViewModel.StatusProperty, ConnectionStatusViewModel.ErrorProperty])
        {
            this.subscriptions.push(this.vm.PropertyChanged(name).subscribe(() => this.Rebuild()))
        }
        this.AddChild(new Section({ title: OverviewConnectionCard.Title, body: this.bodySlot }))
        this.Rebuild()
    }

    // Test seam: the underlying view model.
    public get Vm(): ConnectionStatusViewModel
    {
        return this.vm
    }

    // Test seam: the reachable / quiet pill, or undefined when no link is shown.
    public get Pill(): StatusPill | undefined
    {
        return this.pill
    }

    // Test seam: the detail sentence, or undefined when no link is shown.
    public get DetailText(): string | undefined
    {
        return this.detail
    }

    // Loads once per card; a repeated call returns the first load. A 401 is re-thrown so the caller routes to login.
    public Load(): Promise<void>
    {
        if (this.loadPromise === undefined)
        {
            this.loadPromise = this.vm.Load()
        }
        return this.loadPromise
    }

    public Dispose(): void
    {
        for (const s of this.subscriptions)
        {
            s.dispose()
        }
        this.subscriptions.length = 0
    }

    private static Text(text: string): TextBlock
    {
        const block = new TextBlock()
        block.Text = text
        return block
    }

    private Rebuild(): void
    {
        for (const child of [...this.bodySlot.Children])
        {
            this.bodySlot.RemoveChild(child)
        }
        this.pill = undefined
        this.detail = undefined
        switch (this.vm.State)
        {
            case ConnectionState.Connected:
            case ConnectionState.Quiet:
                this.AddLink(this.vm.State === ConnectionState.Quiet)
                break
            case ConnectionState.NoHive:
                this.bodySlot.AddChild(OverviewConnectionCard.Text(OverviewConnectionCard.NoHiveText))
                return
            case ConnectionState.Forbidden:
                this.bodySlot.AddChild(OverviewConnectionCard.Text(OverviewConnectionCard.ForbiddenText))
                return
            case ConnectionState.Error:
                this.bodySlot.AddChild(OverviewConnectionCard.Text(OverviewConnectionCard.ErrorText))
                if (this.vm.Error)
                {
                    this.bodySlot.AddChild(OverviewConnectionCard.Text(this.vm.Error))
                }
                break
            default:
                this.bodySlot.AddChild(OverviewConnectionCard.Text(OverviewConnectionCard.LoadingText))
                return
        }
        this.bodySlot.AddChild(new Act({ can: true, onClick: () => this.onView(), label: OverviewConnectionCard.ViewLabel }))
    }

    private AddLink(quiet: boolean): void
    {
        const row = new StackPanel()
        row.Orientation = Orientation.Horizontal
        this.pill = new StatusPill(quiet ? PillKind.Quiet : PillKind.Connected)
        this.detail = this.vm.Status?.detail ?? ''
        row.AddChild(this.pill)
        row.AddChild(OverviewConnectionCard.Text(this.detail))
        this.bodySlot.AddChild(row)
    }
}
