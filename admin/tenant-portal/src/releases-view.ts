import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { DataTemplate } from '@pragmatic-tech-ai/mural/basic/templates/data-template.js'
import { GridLength, GridUnitType } from '@pragmatic-tech-ai/mural/basic/panels/grid.js'
import { DataGrid } from '@pragmatic-tech-ai/mural/framework/data-grid/data-grid.js'
import { DataGridTemplateColumn } from '@pragmatic-tech-ai/mural/framework/data-grid/data-grid-column.js'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import { Act, ActVariant, KeyValueGrid, KitGlyph, PillKind, PillTone, ScreenHost, Section, SkeletonKind, StatusPill, Tones } from './kit/index.js'
import type { ScreenHostInputs } from './kit/index.js'
import { AdoptWizard } from './adopt-wizard.js'
import { ReleasesViewModel } from './releases-view-model.js'
import type { MatrixRow, Offer } from './releases-view-model.js'
import { TenantApiError } from './tenant-api-client.js'
import { VersionBadge } from './tenant-types.js'
import type { IReleasesSource, ITenantNavigator, TenantEvent } from './tenant-types.js'
import { TenantViewBase } from './tenant-view-base.js'

// Tenant admin "Releases": offered versions as cards (each with a gated Adopt action that
// opens the inline Adopt wizard) above a runs-what matrix of environments by version.
export class ReleasesView extends TenantViewBase
{
    public static readonly Title = 'Releases'
    public static readonly Sub = 'Versions offered to your hive and what each environment runs.'
    public static readonly AdoptLabel = 'Adopt'
    public static readonly NeedAdopt = 'the Adopt versions permission'
    public static readonly EmptyTitle = 'No new versions offered. New versions arrive when your hive checks in.'
    public static readonly MatrixTitle = 'What runs where'
    public static readonly EnvironmentHeader = 'Environment'
    public static readonly NotRunningText = '\u2014'
    public static readonly VersionKey = 'Version'
    public static readonly PublishedKey = 'Published'
    public static readonly NotesKey = 'Notes'
    public static readonly NotOnKey = 'Environments not on this version'
    public static readonly NotOnSuffix = ' environments not on this version'
    public static readonly CurrentSuffix = ' (current)'
    public static readonly NoText = ''

    private readonly vm: ReleasesViewModel
    private readonly subscriptions: IDisposable[] = []
    private readonly body = new StackPanel()
    private readonly cards = new StackPanel()
    private readonly matrixSlot = new StackPanel()
    private readonly dialogHost = new StackPanel()
    private grid: DataGrid | undefined
    private host: ScreenHost | undefined
    private wizard: AdoptWizard | undefined
    private adoptActs: Act[] = []
    private localError: string | undefined
    private loaded = false

    public constructor(source: IReleasesSource, hiveId: string)
    {
        super()
        this.vm = new ReleasesViewModel(source, hiveId)
        this.Orientation = Orientation.Vertical
        for (const panel of [this.body, this.cards, this.matrixSlot, this.dialogHost])
        {
            panel.Orientation = Orientation.Vertical
        }
        this.body.AddChild(this.dialogHost)
        this.body.AddChild(this.cards)
        this.body.AddChild(this.matrixSlot)
        this.subscriptions.push(this.vm.PropertyChanged(ReleasesViewModel.VersionsProperty).subscribe(() => this.Rebuild()))
        this.host = new ScreenHost(this.Inputs())
        this.AddChild(new Section({ title: ReleasesView.Title, sub: ReleasesView.Sub, body: this.host }))
        this.Rebuild()
    }

    // Test seam: the state host (loading / empty / error / populated).
    public get Host(): ScreenHost
    {
        return this.host as ScreenHost
    }

    // Test seam: the per-offer Adopt actions, in offer order.
    public get AdoptActions(): readonly Act[]
    {
        return this.adoptActs
    }

    // Test seam: the open wizard, or undefined.
    public get OpenWizard(): AdoptWizard | undefined
    {
        return this.wizard
    }

    // Test seam: the matrix grid, or undefined when there is no matrix.
    public get MatrixGrid(): DataGrid | undefined
    {
        return this.grid
    }

    public override AttachNavigator(nav: ITenantNavigator): void
    {
        super.AttachNavigator(nav)
        // Capabilities are only known once the navigator is attached; undefined is permissive.
        this.Rebuild()
    }

    public async Refresh(): Promise<void>
    {
        this.localError = undefined
        try
        {
            await this.vm.Load()
            this.loaded = true
        }
        catch (e)
        {
            this.ReportError(e)
        }
        this.Rebuild()
    }

    public async ApplyEvent(ev: TenantEvent): Promise<void>
    {
        await this.vm.ApplyEvent(ev)
        this.Rebuild()
    }

    public Dispose(): void
    {
        for (const s of this.subscriptions)
        {
            s.dispose()
        }
        this.subscriptions.length = 0
        this.grid?.dispose()
        this.grid = undefined
    }

    private get CanAdopt(): boolean
    {
        return this.Navigator?.Capabilities?.adopt !== false
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
        const none = this.vm.Offers.length === 0
        const failed = this.localError !== undefined
        return {
            loading: !this.loaded && !failed,
            allowed: true,
            isEmpty: this.loaded && none,
            error: failed,
            skeleton: SkeletonKind.Table,
            empty: { glyph: KitGlyph.Layers, title: ReleasesView.EmptyTitle },
            errorConfig: failed ? { title: this.localError } : undefined,
            content: this.body,
        }
    }

    private Rebuild(): void
    {
        this.RebuildCards()
        this.RebuildMatrix()
        this.host?.Update(this.Inputs())
    }

    private RebuildCards(): void
    {
        for (const child of [...this.cards.Children])
        {
            this.cards.RemoveChild(child)
        }
        this.adoptActs = []
        for (const offer of this.vm.Offers)
        {
            this.cards.AddChild(this.MakeCard(offer))
        }
    }

    private MakeCard(offer: Offer): Section
    {
        const items = [
            { key: ReleasesView.VersionKey, value: offer.version },
            { key: ReleasesView.PublishedKey, value: offer.manifest.publishedAt },
        ]
        if (offer.manifest.notes !== undefined && offer.manifest.notes !== ReleasesView.NoText)
        {
            items.push({ key: ReleasesView.NotesKey, value: offer.manifest.notes })
        }
        items.push({ key: ReleasesView.NotOnKey, value: String(offer.notOnCount) })
        const body = new StackPanel()
        body.Orientation = Orientation.Vertical
        body.AddChild(new KeyValueGrid({ items }))
        body.AddChild(ReleasesView.Muted(String(offer.notOnCount) + ReleasesView.NotOnSuffix))
        if (offer.manifest.withdrawn === true)
        {
            body.AddChild(new StatusPill(PillKind.Withdrawn))
        }
        const act = new Act({
            can: this.CanAdopt,
            need: ReleasesView.NeedAdopt,
            onClick: () => this.OpenAdopt(offer.version),
            label: ReleasesView.AdoptLabel,
            variant: ActVariant.Primary,
        })
        this.adoptActs.push(act)
        return new Section({ title: offer.version, actions: act, body })
    }

    private OpenAdopt(version: string): void
    {
        if (this.wizard !== undefined)
        {
            return
        }
        const wizard = new AdoptWizard({ vm: this.vm, version, onClose: () => this.CloseAdopt() })
        this.wizard = wizard
        this.dialogHost.AddChild(wizard)
    }

    private CloseAdopt(): void
    {
        if (this.wizard === undefined)
        {
            return
        }
        this.dialogHost.RemoveChild(this.wizard)
        this.wizard = undefined
    }

    private RebuildMatrix(): void
    {
        for (const child of [...this.matrixSlot.Children])
        {
            this.matrixSlot.RemoveChild(child)
        }
        this.grid?.dispose()
        this.grid = undefined
        const matrix = this.vm.Matrix
        if (matrix.rows.length === 0)
        {
            return
        }
        const grid = new DataGrid()
        grid.Columns.Add(this.TemplateColumn(ReleasesView.EnvironmentHeader, new GridLength(1, GridUnitType.Star), r => ReleasesView.Plain(r.environmentName)))
        for (const column of matrix.columns)
        {
            const suffix = column.badge === VersionBadge.Current ? ReleasesView.CurrentSuffix : ReleasesView.NoText
            grid.Columns.Add(this.TemplateColumn(column.version + suffix, GridLength.Auto, r => ReleasesView.MakeCell(r, column.version)))
        }
        grid.ItemsSource = [...matrix.rows]
        this.grid = grid
        this.matrixSlot.AddChild(new Section({ title: ReleasesView.MatrixTitle, body: grid }))
    }

    private TemplateColumn(header: string, width: GridLength, cell: (row: MatrixRow) => Visual): DataGridTemplateColumn
    {
        const col = new DataGridTemplateColumn()
        col.Header = header
        col.Width = width
        col.CellTemplate = new DataTemplate(data => cell(data as MatrixRow))
        return col
    }

    private static MakeCell(row: MatrixRow, version: string): Visual
    {
        const running = row.cells.some(c => c.version === version && c.running)
        return running ? new StatusPill(PillKind.Running) : ReleasesView.Muted(ReleasesView.NotRunningText)
    }

    private static Plain(text: string): TextBlock
    {
        const t = new TextBlock()
        t.Text = text
        return t
    }

    private static Muted(text: string): TextBlock
    {
        const t = ReleasesView.Plain(text)
        t.Foreground = Tones.Brush(PillTone.Neutral)
        return t
    }
}
