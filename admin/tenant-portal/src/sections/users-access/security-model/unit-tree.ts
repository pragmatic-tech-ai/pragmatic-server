import type { BusinessUnitDto } from '../../../tenant-types.js'
import { NoneChoice, UnitChoices, UnitOptionViewModel, type BusinessUnitRowViewModel } from './security-model-org-rows.js'

// The business-unit choices every unit picker offers and the tree the unit
// rows show. One choice object is kept per unit id across rebuilds (labels
// follow renames), so a ComboBox holding one still finds it in a replaced list.
export class UnitTree
{
    private static readonly NoneLabel = '(none)'
    private static readonly IdOpen = ' ('
    private static readonly IdClose = ')'
    private static readonly MaxDepth = 64

    private readonly options = new Map<string, UnitOptionViewModel>()
    private readonly none = new UnitOptionViewModel(undefined, UnitTree.NoneLabel)

    // The choices of a user's or team's unit picker: every unit, no "(none)".
    public Choices(ids: readonly string[]): UnitChoices
    {
        return new UnitChoices(this.none, this.options, ids, NoneChoice.Omitted)
    }

    // Keeps one choice per unit (a duplicate name gets its id appended so the
    // choices stay distinct) and drops the choices of removed units.
    public SyncOptions(units: readonly BusinessUnitDto[]): void
    {
        const counts = new Map<string, number>()
        for (const unit of units)
        {
            counts.set(unit.name, (counts.get(unit.name) ?? 0) + 1)
        }
        const live = new Set<string>(units.map(u => u.id))
        for (const id of [...this.options.keys()])
        {
            if (!live.has(id))
            {
                this.options.delete(id)
            }
        }
        for (const unit of units)
        {
            const label = (counts.get(unit.name) ?? 0) > 1 ? unit.name + UnitTree.IdOpen + unit.id + UnitTree.IdClose : unit.name
            const option = this.options.get(unit.id)
            if (option === undefined)
            {
                this.options.set(unit.id, new UnitOptionViewModel(unit.id, label))
            }
            else
            {
                option.SetLabel(label)
            }
        }
    }

    // Each unit's depth and parent choices: the root's offers only "(none)";
    // any other unit's offers every unit but itself and its descendants (no
    // "(none)", so the tree stays single-rooted and the picker never offers a
    // cycle).
    public SyncTree(rows: readonly BusinessUnitRowViewModel[], relabel: boolean): void
    {
        const parents = new Map<string, string | undefined>(rows.map(r => [r.Id, r.Parent]))
        const children = new Map<string, string[]>()
        for (const row of rows)
        {
            if (row.Parent !== undefined)
            {
                children.set(row.Parent, [...(children.get(row.Parent) ?? []), row.Id])
            }
        }
        for (const row of rows)
        {
            const depth = UnitTree.DepthOf(row.Id, parents)
            if (row.IsRoot)
            {
                row.SetTree(depth, new UnitChoices(this.none, this.options, [], NoneChoice.Offered), relabel)
                continue
            }
            const excluded = UnitTree.DescendantsOf(row.Id, children)
            excluded.add(row.Id)
            const ids = rows.map(r => r.Id).filter(id => !excluded.has(id))
            row.SetTree(depth, this.Choices(ids), relabel)
        }
    }

    private static DescendantsOf(id: string, children: ReadonlyMap<string, readonly string[]>): Set<string>
    {
        const found = new Set<string>()
        const pending = [...(children.get(id) ?? [])]
        while (pending.length > 0)
        {
            const next = pending.pop() as string
            if (!found.has(next))
            {
                found.add(next)
                pending.push(...(children.get(next) ?? []))
            }
        }
        return found
    }

    // Depth along the parent chain (bounded, so a bad cycle cannot loop).
    private static DepthOf(id: string, parents: ReadonlyMap<string, string | undefined>): number
    {
        let depth = 0
        let parent = parents.get(id)
        while (parent !== undefined && parents.has(parent) && depth < UnitTree.MaxDepth)
        {
            depth++
            parent = parents.get(parent)
        }
        return depth
    }
}
