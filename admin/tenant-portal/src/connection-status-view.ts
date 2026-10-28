import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { Banner, BannerTone, KitGlyph, PillKind, ScreenHost, Section, SkeletonKind, StatusPill } from './kit/index.js'
import type { ScreenHostInputs } from './kit/index.js'
import { ConnectionState, ConnectionStatusViewModel } from './connection-status-view-model.js'
import { TenantApiError } from './tenant-api-client.js'
import { TenantViewBase } from './tenant-view-base.js'
import type { IConnectionSource } from './tenant-types.js'

// Read-only Connection status page: is Pragmatic reachable from the tenant's hive, the
// outbound-only link diagram, and what the hive is running. A quiet link is shown honestly, not as an error.
export class ConnectionStatusView extends TenantViewBase
{
    public static readonly Title = 'Connection status'
    public static readonly Sub = 'How your hive reaches Pragmatic.'
    public static readonly ConnectedText = 'Pragmatic is reachable from your hive.'
    public static readonly QuietText = "Your hive can't reach Pragmatic right now."
    public static readonly QuietBannerText = 'Your environments keep running normally while the link is quiet. Nothing is lost; updates resume when the hive can reach Pragmatic again.'
    public static readonly DiagramTitle = 'How the connection works'
    public static readonly NodeHive = 'Your hive'
    public static readonly NodeLink = 'outbound HTTPS'
    public static readonly NodePragmatic = 'Pragmatic'
    public static readonly Arrow = '\u2192'
    public static readonly OutboundOnlyText = 'Pragmatic never initiates a connection into your hive. Your hive dials out; nothing connects in.'
    public static readonly RunningTitle = "What's running in your hive"
    public static readonly TargetPrefix = 'Target version: '
    public static readonly NoTarget = 'No target version set yet.'
    public static readonly NoImage = 'no image reported'
    public static readonly RunningSeparator = ' - '
    public static readonly NoEnvironments = 'No environments reported yet.'
    public static readonly QuietUnavailable = 'Running versions are unavailable while the link is quiet.'
    public static readonly EmptyTitle = 'No hive yet. Connect a hive to see its connection status.'
    public static readonly ErrorTitle = 'Could not load the connection status.'
    public static readonly DeniedWhat = 'the connection status'
    public static readonly DeniedNeed = 'access to your hive'

    private readonly vm: ConnectionStatusViewModel
    private readonly subscriptions: IDisposable[] = []
    private readonly body = new StackPanel()
    private readonly heroSlot = new StackPanel()
    private readonly bannerSlot = new StackPanel()
    private readonly diagramSlot = new StackPanel()
    private readonly runningSlot = new StackPanel()
    private readonly host: ScreenHost
    private heroPill: StatusPill | undefined
    private heroLabel: TextBlock | undefined
    private banner: Banner | undefined
    private localError: string | undefined

    public constructor(source: IConnectionSource)
    {
        super()
        this.vm = new ConnectionStatusViewModel(source)
        this.Orientation = Orientation.Vertical
        for (const panel of [this.body, this.heroSlot, this.bannerSlot, this.diagramSlot, this.runningSlot])
        {
            panel.Orientation = Orientation.Vertical
        }
        this.body.AddChild(this.heroSlot)
        this.body.AddChild(this.bannerSlot)
        this.body.AddChild(this.diagramSlot)
        this.body.AddChild(this.runningSlot)
        for (const name of [ConnectionStatusViewModel.StateProperty, ConnectionStatusViewModel.StatusProperty, ConnectionStatusViewModel.ErrorProperty])
        {
            this.subscriptions.push(this.vm.PropertyChanged(name).subscribe(() => this.Rebuild()))
        }
        this.host = new ScreenHost(this.Inputs())
        this.AddChild(new Section({ title: ConnectionStatusView.Title, sub: ConnectionStatusView.Sub, body: this.host }))
        this.Rebuild()
    }

    // Test seam: the underlying view model.
    public get Vm(): ConnectionStatusViewModel
    {
        return this.vm
    }

    // Test seam: the state host (loading / empty / error / denied / populated).
    public get StateHost(): ScreenHost
    {
        return this.host
    }

    // Test seam: the quiet banner, present only while Quiet.
    public get QuietBanner(): Banner | undefined
    {
        return this.banner
    }

    // Test seam: the hero status pill, or undefined when no hero is shown.
    public get HeroPill(): StatusPill | undefined
    {
        return this.heroPill
    }

    // Test seam: the hero sentence, or undefined when no hero is shown.
    public get HeroText(): string | undefined
    {
        return this.heroLabel?.Text
    }

    // Test seam: the outbound-only diagram host.
    public get Diagram(): StackPanel
    {
        return this.diagramSlot
    }

    // Test seam: the "what's running" list host.
    public get RunningList(): StackPanel
    {
        return this.runningSlot
    }

    public async Refresh(): Promise<void>
    {
        this.localError = undefined
        try
        {
            await this.vm.Load()
        }
        catch (e)
        {
            this.ReportError(e)
        }
        this.Rebuild()
    }

    public Dispose(): void
    {
        for (const s of this.subscriptions)
        {
            s.dispose()
        }
        this.subscriptions.length = 0
    }

    // A 401 drops to login; every other failure shows through the ScreenHost error state.
    private ReportError(e: unknown): void
    {
        if (e instanceof TenantApiError && e.Status === TenantApiError.UnauthorizedStatus && this.Navigator !== undefined)
        {
            this.ShowError(e)
            return
        }
        this.localError = e instanceof Error ? e.message : String(e)
    }

    private Inputs(): ScreenHostInputs
    {
        const state = this.vm.State
        const failed = state === ConnectionState.Error || this.localError !== undefined
        return {
            loading: state === ConnectionState.Loading && this.localError === undefined,
            allowed: state !== ConnectionState.Forbidden,
            isEmpty: state === ConnectionState.NoHive,
            error: failed,
            skeleton: SkeletonKind.Cards,
            empty: { glyph: KitGlyph.RadioTower, title: ConnectionStatusView.EmptyTitle },
            errorConfig: failed ? { title: ConnectionStatusView.ErrorTitle, body: this.localError ?? this.vm.Error } : undefined,
            denied: { what: ConnectionStatusView.DeniedWhat, need: ConnectionStatusView.DeniedNeed },
            content: this.body,
        }
    }

    private Rebuild(): void
    {
        this.RebuildHero()
        this.RebuildBanner()
        this.RebuildDiagram()
        this.RebuildRunning()
        this.host.Update(this.Inputs())
    }

    private static Clear(panel: StackPanel): void
    {
        for (const child of [...panel.Children])
        {
            panel.RemoveChild(child)
        }
    }

    private get ShowsLink(): boolean
    {
        return this.vm.State === ConnectionState.Connected || this.vm.State === ConnectionState.Quiet
    }

    private RebuildHero(): void
    {
        ConnectionStatusView.Clear(this.heroSlot)
        this.heroPill = undefined
        this.heroLabel = undefined
        if (!this.ShowsLink)
        {
            return
        }
        const quiet = this.vm.State === ConnectionState.Quiet
        const row = new StackPanel()
        row.Orientation = Orientation.Horizontal
        this.heroPill = new StatusPill(quiet ? PillKind.Quiet : PillKind.Connected)
        this.heroLabel = ConnectionStatusView.Text(quiet ? ConnectionStatusView.QuietText : ConnectionStatusView.ConnectedText)
        row.AddChild(this.heroPill)
        row.AddChild(this.heroLabel)
        this.heroSlot.AddChild(row)
    }

    private RebuildBanner(): void
    {
        ConnectionStatusView.Clear(this.bannerSlot)
        this.banner = undefined
        if (this.vm.State !== ConnectionState.Quiet)
        {
            return
        }
        this.banner = new Banner({ tone: BannerTone.Warning, text: ConnectionStatusView.QuietBannerText })
        this.bannerSlot.AddChild(this.banner)
    }

    private RebuildDiagram(): void
    {
        ConnectionStatusView.Clear(this.diagramSlot)
        if (!this.ShowsLink)
        {
            return
        }
        const strip = new StackPanel()
        strip.Orientation = Orientation.Horizontal
        const parts = [
            ConnectionStatusView.NodeHive, ConnectionStatusView.Arrow, ConnectionStatusView.NodeLink,
            ConnectionStatusView.Arrow, ConnectionStatusView.NodePragmatic,
        ]
        for (const part of parts)
        {
            strip.AddChild(ConnectionStatusView.Text(part))
        }
        const inner = new StackPanel()
        inner.Orientation = Orientation.Vertical
        inner.AddChild(strip)
        inner.AddChild(ConnectionStatusView.Text(ConnectionStatusView.OutboundOnlyText))
        this.diagramSlot.AddChild(new Section({ title: ConnectionStatusView.DiagramTitle, body: inner }))
    }

    private RebuildRunning(): void
    {
        ConnectionStatusView.Clear(this.runningSlot)
        if (!this.ShowsLink)
        {
            return
        }
        const list = new StackPanel()
        list.Orientation = Orientation.Vertical
        const status = this.vm.Status
        if (this.vm.State === ConnectionState.Quiet || status === undefined)
        {
            list.AddChild(ConnectionStatusView.Text(ConnectionStatusView.QuietUnavailable))
        }
        else
        {
            list.AddChild(ConnectionStatusView.Text(status.targetVersion === undefined
                ? ConnectionStatusView.NoTarget
                : ConnectionStatusView.TargetPrefix + status.targetVersion))
            if (status.environments.length === 0)
            {
                list.AddChild(ConnectionStatusView.Text(ConnectionStatusView.NoEnvironments))
            }
            for (const env of status.environments)
            {
                const row = new StackPanel()
                row.Orientation = Orientation.Horizontal
                row.AddChild(ConnectionStatusView.Text(env.name + ConnectionStatusView.RunningSeparator + (env.runningImage ?? ConnectionStatusView.NoImage)))
                row.AddChild(new StatusPill(env.ready ? PillKind.Running : PillKind.Pending))
                list.AddChild(row)
            }
        }
        this.runningSlot.AddChild(new Section({ title: ConnectionStatusView.RunningTitle, body: list }))
    }

    private static Text(text: string): TextBlock
    {
        const block = new TextBlock()
        block.Text = text
        return block
    }
}
