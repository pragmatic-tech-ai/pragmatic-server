import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { TreeView, TreeViewItem } from '@pragmatic-tech-ai/mural/framework'
import { SelectionKind } from './tenant-tree-view-model.js'
import type { TenantTreeViewModel, TreeSelection } from './tenant-tree-view-model.js'
import { TenantViewBase } from './tenant-view-base.js'
import type { TenantEvent } from './tenant-types.js'

// Hive -> environment navigation tree. Uses mural TreeView/TreeViewItem; a
// selection forwards to the navigator (detail pane) and records it on the VM.
export class TenantTreeView extends TenantViewBase
{
    public static readonly RootLabel = 'My Hives'
    public static readonly EmptyText = 'No hives yet'
    public static readonly StatusDot = '●'
    public static readonly StatusSeparator = ' '

    private readonly selections = new Map<TreeViewItem, TreeSelection>()
    private tree: TreeView | undefined

    public constructor(private readonly vm: TenantTreeViewModel)
    {
        super()
        this.Rebuild()
    }

    public async Refresh(): Promise<void>
    {
        try
        {
            await this.vm.Load()
        }
        catch (e)
        {
            this.ShowError(e)
            return
        }
        this.Rebuild()
    }

    // Forwarded tenant event: let the VM re-pull, then redraw the tree.
    public ApplyEvent(ev: TenantEvent): void
    {
        void this.vm.ApplyEvent(ev).then(reloaded =>
        {
            if (reloaded)
            {
                this.Rebuild()
            }
        })
    }

    public Rebuild(): void
    {
        for (const child of [...this.Children])
        {
            this.RemoveChild(child)
        }
        this.selections.clear()
        this.tree = undefined
        const root = new TextBlock()
        root.Text = TenantTreeView.RootLabel
        this.AddChild(root)
        this.AddChild(this.message)
        if (this.vm.Nodes.length === 0)
        {
            const empty = new TextBlock()
            empty.Text = TenantTreeView.EmptyText
            this.AddChild(empty)
            return
        }
        const tree = new TreeView()
        for (const node of this.vm.Nodes)
        {
            const hiveItem = this.MakeItem(node.hive.displayName, { kind: SelectionKind.Hive, hive: node.hive })
            hiveItem.IsExpanded = true
            for (const env of node.environments)
            {
                hiveItem.AddChild(this.MakeItem(this.EnvLabel(env.name, env.status), { kind: SelectionKind.Environment, env }))
            }
            tree.AddChild(hiveItem)
        }
        tree.AddSelectionChangedListener(() => this.OnSelectionChanged())
        this.tree = tree
        this.AddChild(tree)
    }

    private EnvLabel(name: string, status: string): string
    {
        return TenantTreeView.StatusDot + TenantTreeView.StatusSeparator + name + TenantTreeView.StatusSeparator + '(' + status + ')'
    }

    private MakeItem(header: string, sel: TreeSelection): TreeViewItem
    {
        const item = new TreeViewItem()
        item.Header = header
        this.selections.set(item, sel)
        return item
    }

    private OnSelectionChanged(): void
    {
        const picked = this.tree?.SelectedContainers[0]
        const sel = picked === undefined ? undefined : this.selections.get(picked as TreeViewItem)
        if (sel === undefined)
        {
            return
        }
        this.vm.Select(sel)
        if (sel.kind === SelectionKind.Hive)
        {
            this.Navigator?.ShowHiveDetail(sel.hive)
        }
        else
        {
            this.Navigator?.ShowEnvironmentDetail(sel.env)
        }
    }
}
