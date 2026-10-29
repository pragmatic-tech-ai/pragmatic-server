import { Orientation, StackPanel } from '@pragmatic-tech-ai/mural/basic'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import { DataTable, PageHeader, ScreenHost, TableDensity } from './kit/index.js'
import type { Act, ScreenHostInputs, TableColumn } from './kit/index.js'
import type { IPortalNavigator, IPortalView } from './portal-types.js'

export interface SectionLabels
{
    listBreadcrumb: readonly string[]
    listTitle: string
    emptyTitle: string
    errorTitle: string
    tableEmptyText: string
}

export enum SectionState
{
    List,
    Detail,
    Custom,
}

// Model-agnostic self-routing section container (list / detail). Subclasses supply data and
// presentation through hooks. Every screen swap clears the content host and adds a freshly built
// screen (one parent per Visual); the list slot is rebuilt on every render.
export abstract class SectionContainerView<TRow> extends StackPanel implements IPortalView
{
    private static readonly ListDensity = TableDensity.Dense

    private readonly content = new StackPanel()
    private host: ScreenHost
    private listSlot = new StackPanel()
    private state = SectionState.List
    private listMounted = true
    private detailRow: TRow | undefined
    private rows: readonly TRow[] = []
    private loaded = false
    private nav: IPortalNavigator | undefined

    protected constructor()
    {
        super()
        this.Orientation = Orientation.Vertical
        this.content.Orientation = Orientation.Vertical
        this.host = new ScreenHost(SectionContainerView.BareLoading())
        this.AddChild(this.content)
        this.content.AddChild(this.host)
    }

    protected abstract LoadRows(): Promise<readonly TRow[]>

    protected abstract BuildDetail(row: TRow): Promise<Visual | undefined>

    protected abstract Columns(): TableColumn<TRow>[]

    protected abstract SearchText(row: TRow): string

    protected abstract Labels(): SectionLabels

    protected ListPrimaryAction(): Act | undefined
    {
        return undefined
    }

    protected ListSecondaryAction(): Act | undefined
    {
        return undefined
    }

    // Test seam: the list screen's host.
    public get Host(): ScreenHost
    {
        return this.host
    }

    // Test seam: the list table (populated list only).
    public get Table(): DataTable<TRow> | undefined
    {
        const child = [...this.listSlot.Children][0]
        return child instanceof DataTable ? child as DataTable<TRow> : undefined
    }

    protected get State(): SectionState
    {
        return this.state
    }

    public AttachNavigator(nav: IPortalNavigator): void
    {
        this.nav = nav
    }

    public async Refresh(): Promise<void>
    {
        if (this.state === SectionState.Detail && this.detailRow !== undefined)
        {
            await this.ShowDetail(this.detailRow)
        }
        else if (this.state === SectionState.List)
        {
            await this.ShowList()
        }
    }

    public async ShowList(): Promise<void>
    {
        if (!this.listMounted)
        {
            this.host = new ScreenHost(this.LoadingInputs())
            this.SwapScreen(this.host)
            this.listMounted = true
        }
        this.state = SectionState.List
        this.detailRow = undefined
        if (!this.loaded)
        {
            this.host.Update(this.LoadingInputs())
        }
        try
        {
            this.rows = await this.LoadRows()
            this.loaded = true
        }
        catch
        {
            if (this.state !== SectionState.List)
            {
                return
            }
            this.host.Update(this.ErrorInputs())
            return
        }
        if (this.state !== SectionState.List)
        {
            return
        }
        this.host.Update(this.LoadedInputs())
    }

    public async ShowDetail(row: TRow): Promise<void>
    {
        this.state = SectionState.Detail
        this.detailRow = row
        let detail: Visual | undefined
        try
        {
            detail = await this.BuildDetail(row)
        }
        catch
        {
            detail = undefined
        }
        if (this.state !== SectionState.Detail || this.detailRow !== row)
        {
            return
        }
        if (detail === undefined)
        {
            this.state = SectionState.List
            this.detailRow = undefined
            this.listMounted = true
            this.host = new ScreenHost(this.ErrorInputs())
            this.SwapScreen(this.host)
            return
        }
        this.listMounted = false
        this.SwapScreen(detail)
    }

    protected EnterCustom(): void
    {
        this.state = SectionState.Custom
        this.listMounted = false
    }

    protected SwapScreen(screen: Visual): void
    {
        for (const child of [...this.content.Children])
        {
            this.content.RemoveChild(child)
        }
        this.content.AddChild(screen)
    }

    private static BareLoading(): ScreenHostInputs
    {
        return { loading: true, allowed: true, error: false, isEmpty: false }
    }

    private LoadingInputs(): ScreenHostInputs
    {
        const labels = this.Labels()
        return {
            loading: true,
            allowed: true,
            error: false,
            isEmpty: false,
            empty: { title: labels.emptyTitle },
            errorConfig: { title: labels.errorTitle, onRetry: () => void this.Refresh() },
        }
    }

    private ErrorInputs(): ScreenHostInputs
    {
        const labels = this.Labels()
        return {
            loading: false,
            allowed: true,
            error: true,
            isEmpty: true,
            empty: { title: labels.emptyTitle },
            errorConfig: { title: labels.errorTitle, onRetry: () => void this.Refresh() },
        }
    }

    private LoadedInputs(): ScreenHostInputs
    {
        const labels = this.Labels()
        return {
            loading: false,
            allowed: true,
            error: false,
            isEmpty: this.rows.length === 0,
            empty: { title: labels.emptyTitle, action: this.ListPrimaryAction(), secondaryAction: this.ListSecondaryAction() },
            errorConfig: { title: labels.errorTitle, onRetry: () => void this.Refresh() },
            content: () => this.BuildList(),
        }
    }

    private BuildList(): Visual
    {
        const labels = this.Labels()
        const root = new StackPanel()
        root.Orientation = Orientation.Vertical
        root.AddChild(new PageHeader({
            breadcrumb: labels.listBreadcrumb,
            title: labels.listTitle,
            primaryAction: this.ListPrimaryAction(),
            secondaryAction: this.ListSecondaryAction(),
        }))
        // Fresh slot per render: the previous one is still parented to the previous root.
        this.listSlot = new StackPanel()
        this.listSlot.Orientation = Orientation.Vertical
        this.listSlot.AddChild(new DataTable<TRow>({
            columns: this.Columns(),
            rows: this.rows,
            density: SectionContainerView.ListDensity,
            searchText: r => this.SearchText(r),
            onOpen: r => void this.ShowDetail(r),
            emptyText: labels.tableEmptyText,
        }))
        root.AddChild(this.listSlot)
        return root
    }
}
