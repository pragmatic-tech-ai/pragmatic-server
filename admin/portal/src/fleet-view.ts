import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import type { ControlPlaneClient } from './api-client.js'
import { FleetConnection, FleetSegment, FleetViewModel } from './fleet-view-model.js'
import type { FleetRow } from './fleet-view-model.js'
import {
    DataTable, KeyActivatedButton, PageHeader, PillKind, PillKinds, PillTone, ScreenHost, Section, TableDensity,
} from './kit/index.js'
import type { ScreenHostInputs, TableColumn } from './kit/index.js'
import type { IPortalNavigator, IPortalView } from './portal-types.js'

// Fleet overview home: every hive read from its last check-in, exceptions first. Observes only:
// no command and no navigation (hive detail and "stand up a hive" are deferred).
export class FleetView extends StackPanel implements IPortalView
{
    private static readonly Breadcrumb: readonly string[] = ['Fleet']
    private static readonly TitleText = 'Fleet'
    private static readonly SubText = 'Every hive, read from its last check-in. Exceptions first.'
    private static readonly HivesLabel = 'Hives'
    private static readonly NeedAttentionLabel = 'Need attention'
    private static readonly NotCheckingInLabel = 'Not checking in'
    private static readonly EnvironmentsLabel = 'Environments observed'
    private static readonly AttentionTitle = 'Needs attention'
    private static readonly AttentionNoneText = 'Nothing needs attention.'
    private static readonly AttentionSeparator = ' - '
    private static readonly IssueSeparator = '; '
    private static readonly HiveKey = 'hive'
    private static readonly OwnerKey = 'owner'
    private static readonly ConnectionKey = 'connection'
    private static readonly HealthKey = 'health'
    private static readonly EnvsKey = 'envs'
    private static readonly IssuesKey = 'issues'
    private static readonly HiveHeader = 'Hive'
    private static readonly OwnerHeader = 'Client / tenant'
    private static readonly ConnectionHeader = 'Connection'
    private static readonly HealthHeader = 'Health'
    private static readonly EnvsHeader = 'Envs'
    private static readonly IssuesHeader = 'Issues'
    private static readonly NoIssuesText = 'None'
    private static readonly ConnectionSeparator = ' - '
    private static readonly SearchSeparator = ' '
    private static readonly SegmentAllLabel = 'All'
    private static readonly SegmentAttentionLabel = 'Needs attention'
    private static readonly SegmentNotCheckingLabel = 'Not checking in'
    private static readonly HivesTitle = 'Hives'
    // Trust boundary: this data is read from each hive's last check-in, never commanded. The caption makes the "observed" framing explicit.
    private static readonly ObservedCaption = "Observed from each hive's last check-in."
    private static readonly TableEmptyText = 'No hives match.'
    private static readonly EmptyTitle = 'No hives yet. Hives appear here once they are registered and dial in.'
    private static readonly ErrorTitle = 'Could not load the fleet.'

    private readonly client: ControlPlaneClient
    private readonly host: ScreenHost
    // Rebuilt fresh on every BuildContent: a Visual may hold only one parent, so reusing one slot across
    // renders (the environments-changed live-refresh path) would double-parent it and throw.
    private tableSlot = new StackPanel()
    private model: FleetViewModel | undefined
    private nav: IPortalNavigator | undefined

    public constructor(client: ControlPlaneClient)
    {
        super()
        this.client = client
        this.Orientation = Orientation.Vertical
        this.tableSlot.Orientation = Orientation.Vertical
        this.host = new ScreenHost(FleetView.Inputs(true, false, true))
        this.AddChild(this.host)
    }

    // Test seam: the fleet view-model once loaded.
    public get Model(): FleetViewModel | undefined
    {
        return this.model
    }

    // Test seam: the body host.
    public get Host(): ScreenHost
    {
        return this.host
    }

    // Test seam: the attached navigator.
    public get Navigator(): IPortalNavigator | undefined
    {
        return this.nav
    }

    // Test seam: the currently shown hive table (populated state only).
    public get Table(): DataTable<FleetRow> | undefined
    {
        const child = [...this.tableSlot.Children][0]
        return child instanceof DataTable ? child as DataTable<FleetRow> : undefined
    }

    public AttachNavigator(nav: IPortalNavigator): void
    {
        this.nav = nav
    }

    public async Refresh(): Promise<void>
    {
        if (this.model === undefined)
        {
            this.host.Update(FleetView.Inputs(true, false, true))
        }
        try
        {
            const dtos = await this.client.ListFleet()
            if (this.model === undefined)
            {
                this.model = new FleetViewModel(dtos)
            }
            else
            {
                this.model.Update(dtos)
            }
        }
        catch
        {
            this.host.Update(FleetView.Inputs(false, true, true))
            return
        }
        this.ShowModel(this.model)
    }

    private static Inputs(loading: boolean, error: boolean, isEmpty: boolean, content?: () => Visual): ScreenHostInputs
    {
        return {
            loading,
            allowed: true,
            error,
            isEmpty,
            empty: { title: FleetView.EmptyTitle },
            errorConfig: { title: FleetView.ErrorTitle },
            content,
        }
    }

    private ShowModel(model: FleetViewModel): void
    {
        this.host.Update(FleetView.Inputs(false, false, model.HiveCount === 0, () => this.BuildContent(model)))
    }

    private BuildContent(model: FleetViewModel): Visual
    {
        const root = new StackPanel()
        root.Orientation = Orientation.Vertical
        root.AddChild(new PageHeader({ breadcrumb: FleetView.Breadcrumb, title: FleetView.TitleText, sub: FleetView.SubText }))
        root.AddChild(this.BuildTiles(model))
        root.AddChild(this.BuildAttention(model))
        // Fresh slot per render: the previous one is still parented to the previous Section.
        this.tableSlot = new StackPanel()
        this.tableSlot.Orientation = Orientation.Vertical
        root.AddChild(new Section({
            title: FleetView.HivesTitle,
            sub: FleetView.ObservedCaption,
            actions: this.BuildSegments(model),
            body: this.tableSlot,
        }))
        this.RebuildTable(model)
        return root
    }

    private BuildTiles(model: FleetViewModel): Visual
    {
        const row = new StackPanel()
        row.Orientation = Orientation.Horizontal
        row.AddChild(FleetView.Tile(FleetView.HivesLabel, model.HiveCount))
        row.AddChild(FleetView.Tile(FleetView.NeedAttentionLabel, model.NeedAttentionCount))
        row.AddChild(FleetView.Tile(FleetView.NotCheckingInLabel, model.NotCheckingInCount))
        row.AddChild(FleetView.Tile(FleetView.EnvironmentsLabel, model.EnvironmentsObserved))
        return row
    }

    // Text tile: value and label, never colour-only.
    private static Tile(label: string, value: number): Visual
    {
        const tile = new StackPanel()
        tile.Orientation = Orientation.Vertical
        const v = new TextBlock()
        v.Text = String(value)
        const l = new TextBlock()
        l.Text = label
        tile.AddChild(v)
        tile.AddChild(l)
        return tile
    }

    // Informational rows (hive + issue summaries); deliberately not buttons.
    private BuildAttention(model: FleetViewModel): Visual
    {
        const body = new StackPanel()
        body.Orientation = Orientation.Vertical
        const items = model.NeedsAttention
        if (items.length === 0)
        {
            const none = new TextBlock()
            none.Text = FleetView.AttentionNoneText
            body.AddChild(none)
        }
        for (const item of items)
        {
            const line = new TextBlock()
            line.Text = item.displayName + FleetView.AttentionSeparator
                + item.issues.map(i => i.summary).join(FleetView.IssueSeparator)
            body.AddChild(line)
        }
        return new Section({ title: FleetView.AttentionTitle, body })
    }

    private BuildSegments(model: FleetViewModel): Visual
    {
        const bar = new StackPanel()
        bar.Orientation = Orientation.Horizontal
        const defs: ReadonlyArray<readonly [FleetSegment, string]> = [
            [FleetSegment.All, FleetView.SegmentAllLabel],
            [FleetSegment.NeedsAttention, FleetView.SegmentAttentionLabel],
            [FleetSegment.NotCheckingIn, FleetView.SegmentNotCheckingLabel],
        ]
        for (const [segment, label] of defs)
        {
            const button = new KeyActivatedButton(() => this.SelectSegment(model, segment))
            const text = new TextBlock()
            text.Text = label
            button.Content = text
            bar.AddChild(button)
        }
        return bar
    }

    private SelectSegment(model: FleetViewModel, segment: FleetSegment): void
    {
        model.SetSegment(segment)
        this.RebuildTable(model)
    }

    private RebuildTable(model: FleetViewModel): void
    {
        for (const child of [...this.tableSlot.Children])
        {
            this.tableSlot.RemoveChild(child)
        }
        this.tableSlot.AddChild(new DataTable<FleetRow>({
            columns: FleetView.Columns(),
            rows: model.Visible(),
            density: TableDensity.Dense,
            searchText: r => r.displayName + FleetView.SearchSeparator + r.ownerLabel,
            emptyText: FleetView.TableEmptyText,
        }))
    }

    private static ConnectionKind(c: FleetConnection): PillKind
    {
        switch (c)
        {
            case FleetConnection.Connected:
                return PillKind.Connected
            case FleetConnection.Quiet:
                return PillKind.Quiet
            default:
                return PillKind.Awaiting
        }
    }

    private static HealthKind(r: FleetRow): PillKind
    {
        return r.notReadyCount > 0 ? PillKind.Failing : PillKind.Healthy
    }

    // Table cells are text, so each pill kind contributes its label (and the row tone) rather than a widget.
    private static Columns(): TableColumn<FleetRow>[]
    {
        return [
            {
                key: FleetView.HiveKey,
                header: FleetView.HiveHeader,
                cell: r => r.displayName,
                sort: (a, b) => a.displayName.localeCompare(b.displayName),
            },
            {
                key: FleetView.OwnerKey,
                header: FleetView.OwnerHeader,
                cell: r => r.ownerLabel,
                sort: (a, b) => a.ownerLabel.localeCompare(b.ownerLabel),
            },
            {
                key: FleetView.ConnectionKey,
                header: FleetView.ConnectionHeader,
                cell: r => PillKinds.For(FleetView.ConnectionKind(r.connection)).label
                    + FleetView.ConnectionSeparator + r.lastSeenLabel,
                tone: r => r.connection === FleetConnection.Connected
                    ? undefined
                    : PillKinds.For(FleetView.ConnectionKind(r.connection)).tone,
            },
            {
                key: FleetView.HealthKey,
                header: FleetView.HealthHeader,
                cell: r => PillKinds.For(FleetView.HealthKind(r)).label,
                tone: r => r.notReadyCount > 0 ? PillTone.Danger : undefined,
            },
            {
                key: FleetView.EnvsKey,
                header: FleetView.EnvsHeader,
                cell: r => String(r.envCount),
                sort: (a, b) => a.envCount - b.envCount,
            },
            {
                key: FleetView.IssuesKey,
                header: FleetView.IssuesHeader,
                cell: r => r.issues.length === 0
                    ? FleetView.NoIssuesText
                    : r.issues.map(i => i.summary).join(FleetView.IssueSeparator),
            },
        ]
    }
}
