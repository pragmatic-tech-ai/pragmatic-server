import { Icon, Orientation, StackPanel, TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { Key, Thickness } from '@pragmatic-tech-ai/mural/runtime'
import type { KeyEventArgs, PointerEventArgs, Visual } from '@pragmatic-tech-ai/mural/runtime'
import { IconCatalog, KitGlyph } from './icon-catalog.js'
import { KeyActivatedButton } from './key-activated-button.js'
import { PillTone, Tones } from './tones.js'

export enum TableDensity
{
    Comfortable,
    Dense,
}

export interface TableColumn<T>
{
    key: string
    header: string
    cell(row: T): string
    sort?(a: T, b: T): number
    tone?(row: T): PillTone | undefined
}

export interface DataTableInputs<T>
{
    columns: readonly TableColumn<T>[]
    rows: readonly T[]
    density?: TableDensity
    searchText?(row: T): string
    onOpen?(row: T): void
    selectable?: boolean
    bulk?: readonly { label: string; onRun(rows: readonly T[]): void }[]
    emptyText: string
}

// A focusable data row. A pointer press outside any button (e.g. the select toggle) reports the click.
class DataRow extends StackPanel
{
    private readonly onClick: () => void

    public constructor(onClick: () => void)
    {
        super()
        this.onClick = onClick
        this.Orientation = Orientation.Horizontal
        this.Focusable = true
    }

    protected override OnPointerDown(args: PointerEventArgs): void
    {
        super.OnPointerDown(args)
        let node: Visual | undefined = args.Source
        while (node !== undefined && node !== this)
        {
            if (node instanceof KeyActivatedButton)
            {
                return
            }
            node = node.GetVisualParent()
        }
        this.onClick()
    }
}

// Generic data table: sortable headers, search, density, selection + bulk bar, per-row tone and
// keyboard navigation (j/k/Enter, "/" focuses search). Keys are handled at the table level: key
// events from focused rows bubble to OnKeyDown here; events originating in the search box or a
// button are ignored so typing and button activation are not hijacked.
export class DataTable<T> extends StackPanel
{
    private static readonly SearchPlaceholder = 'Search'
    private static readonly DensityComfortableLabel = 'Comfortable'
    private static readonly DensityDenseLabel = 'Dense'
    private static readonly SelectedCountSuffix = ' selected'
    private static readonly SlashText = '/'
    private static readonly ColumnWidth = 160
    private static readonly SelectWidth = 28
    private static readonly ComfortableGap = 8
    private static readonly DenseGap = 2

    private readonly inputs: DataTableInputs<T>
    private readonly toolbar = new StackPanel()
    private readonly bulkBar = new StackPanel()
    private readonly headerRow = new StackPanel()
    private readonly body = new StackPanel()
    private readonly searchBox = new TextBox()
    private readonly densityButton: KeyActivatedButton
    private readonly selected: T[] = []
    private rowVisuals: DataRow[] = []
    private shownRows: T[] = []
    private density: TableDensity
    private sortKey: string | undefined
    private sortAscending = true
    private query = ''
    private focusedIndex = -1

    public constructor(inputs: DataTableInputs<T>)
    {
        super()
        this.inputs = inputs
        this.density = inputs.density ?? TableDensity.Comfortable
        this.Orientation = Orientation.Vertical
        this.densityButton = new KeyActivatedButton(() => this.ToggleDensity())
        this.toolbar.Orientation = Orientation.Horizontal
        this.bulkBar.Orientation = Orientation.Horizontal
        this.headerRow.Orientation = Orientation.Horizontal
        this.body.Orientation = Orientation.Vertical
        this.BuildToolbar()
        this.AddChild(this.toolbar)
        this.AddChild(this.bulkBar)
        this.AddChild(this.headerRow)
        this.AddChild(this.body)
        this.Rebuild()
    }

    public get Rows(): readonly StackPanel[]
    {
        return this.rowVisuals
    }

    public get Density(): TableDensity
    {
        return this.density
    }

    public get SortKey(): string | undefined
    {
        return this.sortKey
    }

    public get Selection(): readonly T[]
    {
        return this.selected
    }

    public get FocusedIndex(): number
    {
        return this.focusedIndex
    }

    public SetSearch(text: string): void
    {
        this.query = text
        if (this.searchBox.Text !== text)
        {
            this.searchBox.Text = text
        }
        this.focusedIndex = -1
        this.Rebuild()
    }

    public ToggleDensity(): void
    {
        this.density = this.density === TableDensity.Comfortable ? TableDensity.Dense : TableDensity.Comfortable
        this.Rebuild()
    }

    public SortBy(key: string): void
    {
        if (this.sortKey === key)
        {
            this.sortAscending = !this.sortAscending
        }
        else
        {
            this.sortKey = key
            this.sortAscending = true
        }
        this.focusedIndex = -1
        this.Rebuild()
    }

    public ToggleSelect(row: T): void
    {
        const at = this.selected.indexOf(row)
        if (at >= 0)
        {
            this.selected.splice(at, 1)
        }
        else
        {
            this.selected.push(row)
        }
        this.Rebuild()
    }

    public FocusRow(i: number): void
    {
        if (i < 0 || i >= this.rowVisuals.length)
        {
            return
        }
        this.focusedIndex = i
        this.PaintRows()
        this.rowVisuals[i].Focus()
    }

    public ActivateFocused(): void
    {
        const row = this.shownRows[this.focusedIndex]
        if (row !== undefined)
        {
            this.inputs.onOpen?.(row)
        }
    }

    // deferred: x to toggle-select the focused row, and g+letter go-to chords.
    protected override OnKeyDown(args: KeyEventArgs): void
    {
        super.OnKeyDown(args)
        if (args.Handled || args.Source instanceof TextBox || args.Source instanceof KeyActivatedButton)
        {
            return
        }
        if (args.Key === Key.J)
        {
            this.FocusRow(Math.min(this.focusedIndex + 1, this.rowVisuals.length - 1))
        }
        else if (args.Key === Key.K)
        {
            this.FocusRow(Math.max(this.focusedIndex - 1, 0))
        }
        else if (args.Key === Key.Return)
        {
            this.ActivateFocused()
        }
        else if (args.Key === Key.Oem2 || args.KeyText === DataTable.SlashText)
        {
            this.searchBox.Focus()
        }
        else
        {
            return
        }
        args.Handled = true
    }

    private BuildToolbar(): void
    {
        if (this.inputs.searchText !== undefined)
        {
            this.searchBox.Placeholder = DataTable.SearchPlaceholder
            this.searchBox.PropertyChanged(TextBox.TextKey).subscribe(() =>
            {
                if (this.searchBox.Text !== this.query)
                {
                    this.SetSearch(this.searchBox.Text)
                }
            })
            const icon = new Icon()
            icon.Source = IconCatalog.Definition(KitGlyph.Search)
            this.toolbar.AddChild(icon)
            this.toolbar.AddChild(this.searchBox)
        }
        this.toolbar.AddChild(this.densityButton)
    }

    private Rebuild(): void
    {
        this.RefreshDensityLabel()
        this.RebuildBulkBar()
        this.RebuildHeader()
        this.RebuildBody()
    }

    private RefreshDensityLabel(): void
    {
        const label = new TextBlock()
        label.Text = this.density === TableDensity.Comfortable ? DataTable.DensityComfortableLabel : DataTable.DensityDenseLabel
        this.densityButton.Content = label
    }

    private RebuildBulkBar(): void
    {
        this.Clear(this.bulkBar)
        const bulk = this.inputs.bulk
        if (bulk === undefined || this.selected.length === 0)
        {
            return
        }
        const count = new TextBlock()
        count.Text = String(this.selected.length) + DataTable.SelectedCountSuffix
        this.bulkBar.AddChild(count)
        for (const action of bulk)
        {
            const button = new KeyActivatedButton(() => action.onRun([...this.selected]))
            const text = new TextBlock()
            text.Text = action.label
            button.Content = text
            this.bulkBar.AddChild(button)
        }
    }

    private RebuildHeader(): void
    {
        this.Clear(this.headerRow)
        if (this.inputs.selectable === true)
        {
            const spacer = new TextBlock()
            spacer.Width = DataTable.SelectWidth
            this.headerRow.AddChild(spacer)
        }
        for (const column of this.inputs.columns)
        {
            this.headerRow.AddChild(this.HeaderCell(column))
        }
    }

    private HeaderCell(column: TableColumn<T>): Visual
    {
        const text = new TextBlock()
        text.Text = column.header
        text.Width = DataTable.ColumnWidth
        if (column.sort === undefined)
        {
            return text
        }
        const content = new StackPanel()
        content.Orientation = Orientation.Horizontal
        content.AddChild(text)
        if (this.sortKey === column.key)
        {
            const arrow = new Icon()
            arrow.Source = IconCatalog.Definition(this.sortAscending ? KitGlyph.ChevronUp : KitGlyph.ChevronDown)
            content.AddChild(arrow)
        }
        const button = new KeyActivatedButton(() => this.SortBy(column.key))
        button.Content = content
        return button
    }

    private RebuildBody(): void
    {
        this.Clear(this.body)
        this.shownRows = this.VisibleRows()
        this.rowVisuals = []
        if (this.shownRows.length === 0)
        {
            const empty = new TextBlock()
            empty.Text = this.inputs.emptyText
            this.body.AddChild(empty)
            this.focusedIndex = -1
            return
        }
        this.shownRows.forEach((row, index) =>
        {
            const visual = this.BuildRow(row, index)
            this.rowVisuals.push(visual)
            this.body.AddChild(visual)
        })
        if (this.focusedIndex >= this.rowVisuals.length)
        {
            this.focusedIndex = this.rowVisuals.length - 1
        }
        this.PaintRows()
    }

    private BuildRow(row: T, index: number): DataRow
    {
        const visual = new DataRow(() =>
        {
            this.FocusRow(index)
            this.inputs.onOpen?.(row)
        })
        const gap = this.density === TableDensity.Comfortable ? DataTable.ComfortableGap : DataTable.DenseGap
        visual.Margin = new Thickness(0, gap)
        if (this.inputs.selectable === true)
        {
            visual.AddChild(this.SelectToggle(row))
        }
        for (const column of this.inputs.columns)
        {
            const text = new TextBlock()
            text.Text = column.cell(row)
            text.Width = DataTable.ColumnWidth
            visual.AddChild(text)
        }
        return visual
    }

    private SelectToggle(row: T): KeyActivatedButton
    {
        const button = new KeyActivatedButton(() => this.ToggleSelect(row))
        if (this.selected.includes(row))
        {
            const check = new Icon()
            check.Source = IconCatalog.Definition(KitGlyph.Check)
            button.Content = check
        }
        else
        {
            const blank = new TextBlock()
            blank.Width = DataTable.SelectWidth
            button.Content = blank
        }
        return button
    }

    // Row background: the focus affordance wins, then the per-row tone, else none (neutral).
    private PaintRows(): void
    {
        this.rowVisuals.forEach((visual, index) =>
        {
            if (index === this.focusedIndex)
            {
                visual.Fill = Tones.SoftBrush(PillTone.Info)
                return
            }
            const tone = this.RowTone(this.shownRows[index])
            visual.Fill = tone === undefined ? undefined : Tones.SoftBrush(tone)
        })
    }

    private RowTone(row: T): PillTone | undefined
    {
        for (const column of this.inputs.columns)
        {
            const tone = column.tone?.(row)
            if (tone !== undefined)
            {
                return tone
            }
        }
        return undefined
    }

    private VisibleRows(): T[]
    {
        let rows = [...this.inputs.rows]
        const text = this.inputs.searchText
        const needle = this.query.trim().toLowerCase()
        if (text !== undefined && needle.length > 0)
        {
            rows = rows.filter(r => text(r).toLowerCase().includes(needle))
        }
        const column = this.inputs.columns.find(c => c.key === this.sortKey)
        if (column?.sort !== undefined)
        {
            const compare = column.sort
            const sign = this.sortAscending ? 1 : -1
            rows.sort((a, b) => sign * compare(a, b))
        }
        return rows
    }

    private Clear(panel: StackPanel): void
    {
        for (const child of [...panel.Children])
        {
            panel.RemoveChild(child)
        }
    }
}
