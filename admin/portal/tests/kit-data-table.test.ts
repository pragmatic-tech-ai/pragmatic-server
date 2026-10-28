import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { Key, Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { DataTable, KeyActivatedButton, PillTone, TableDensity } from '../src/kit/index.js'
import type { DataTableInputs } from '../src/kit/index.js'

interface Row
{
    name: string
    n: number
}

class Fixtures
{
    public static readonly Empty = 'Nothing here'
    public static readonly Alice: Row = { name: 'alice', n: 3 }
    public static readonly Bob: Row = { name: 'bob', n: 1 }
    public static readonly Carol: Row = { name: 'carol', n: 2 }

    public static Collect(node: unknown, out: unknown[] = []): unknown[]
    {
        out.push(node)
        const children = (node as { Children?: Iterable<unknown> }).Children
        if (children !== undefined)
        {
            for (const c of children)
            {
                Fixtures.Collect(c, out)
            }
        }
        return out
    }

    public static Texts(node: unknown): string[]
    {
        return Fixtures.Collect(node).filter(n => n instanceof TextBlock).map(n => (n as TextBlock).Text)
    }

    public static Buttons(node: unknown): KeyActivatedButton[]
    {
        return Fixtures.Collect(node).filter(n => n instanceof KeyActivatedButton) as KeyActivatedButton[]
    }

    public static Label(b: KeyActivatedButton): string[]
    {
        return Fixtures.Texts((b as unknown as { Content: unknown }).Content)
    }

    public static Press(table: unknown, key: Key, text: string): void
    {
        (table as { OnKeyDown(a: unknown): void }).OnKeyDown({ Key: key, KeyText: text, Source: table, Handled: false })
    }

    public static Make(over: Partial<DataTableInputs<Row>> = {}): DataTable<Row>
    {
        return new DataTable<Row>({
            columns: [
                { key: 'name', header: 'Name', cell: r => r.name, sort: (a, b) => a.name.localeCompare(b.name) },
                { key: 'n', header: 'N', cell: r => String(r.n), tone: r => (r.n > 2 ? PillTone.Danger : undefined) },
            ],
            rows: [Fixtures.Carol, Fixtures.Alice, Fixtures.Bob],
            searchText: r => r.name,
            emptyText: Fixtures.Empty,
            ...over,
        })
    }

    public static Names(t: DataTable<Row>): string[]
    {
        return t.Rows.map(r => Fixtures.Texts(r)[0] ?? '')
    }
}

describe('kit DataTable', () =>
{
    let previous: Application | null

    before(() =>
    {
        previous = Application.current
        const app = new Application()
        Application.current = app
        app.initialize({ theme: Pragmatic, scheme: PragmaticLight })
    })

    after(() =>
    {
        Application.current = previous
    })

    it('empty rows show emptyText and zero data rows', () =>
    {
        const t = Fixtures.Make({ rows: [] })
        assert.equal(t.Rows.length, 0)
        assert.ok(Fixtures.Texts(t).includes(Fixtures.Empty))
    })

    it('renders one row per item with no emptyText', () =>
    {
        const t = Fixtures.Make()
        assert.equal(t.Rows.length, 3)
        assert.ok(!Fixtures.Texts(t).includes(Fixtures.Empty))
    })

    it('SetSearch filters case-insensitively and falls back to empty text', () =>
    {
        const t = Fixtures.Make()
        t.SetSearch('AL')
        assert.deepEqual(Fixtures.Names(t), ['alice'])
        t.SetSearch('zzz')
        assert.equal(t.Rows.length, 0)
        assert.ok(Fixtures.Texts(t).includes(Fixtures.Empty))
    })

    it('typing in the search box filters; no box without searchText', () =>
    {
        const t = Fixtures.Make()
        const box = Fixtures.Collect(t).find(n => n instanceof TextBox) as TextBox
        box.Text = 'bo'
        assert.deepEqual(Fixtures.Names(t), ['bob'])
        const plain = Fixtures.Make({ searchText: undefined })
        assert.equal(Fixtures.Collect(plain).some(n => n instanceof TextBox), false)
    })

    it('SortBy orders by the column sort and toggles descending', () =>
    {
        const t = Fixtures.Make()
        t.SortBy('name')
        assert.equal(t.SortKey, 'name')
        assert.deepEqual(Fixtures.Names(t), ['alice', 'bob', 'carol'])
        t.SortBy('name')
        assert.deepEqual(Fixtures.Names(t), ['carol', 'bob', 'alice'])
    })

    it('the sort header is a KeyActivatedButton that sorts when activated', () =>
    {
        const t = Fixtures.Make()
        const header = Fixtures.Buttons(t).find(b => Fixtures.Label(b).includes('Name'))
        assert.ok(header instanceof KeyActivatedButton)
        ;(header as unknown as { OnKeyDown(a: unknown): void }).OnKeyDown({ Key: Key.Return, Handled: false })
        assert.equal(t.SortKey, 'name')
    })

    it('ToggleDensity flips Density', () =>
    {
        const t = Fixtures.Make()
        assert.equal(t.Density, TableDensity.Comfortable)
        t.ToggleDensity()
        assert.equal(t.Density, TableDensity.Dense)
        t.ToggleDensity()
        assert.equal(t.Density, TableDensity.Comfortable)
    })

    it('selection adds/removes and the bulk bar runs with the selection', () =>
    {
        const received: Row[][] = []
        const t = Fixtures.Make({ selectable: true, bulk: [{ label: 'Archive all', onRun: rows => received.push([...rows]) }] })
        const bulkLabel = (): KeyActivatedButton | undefined => Fixtures.Buttons(t).find(b => Fixtures.Label(b).includes('Archive all'))
        assert.equal(bulkLabel(), undefined)
        t.ToggleSelect(Fixtures.Alice)
        assert.deepEqual([...t.Selection], [Fixtures.Alice])
        const bulk = bulkLabel()
        assert.ok(bulk instanceof KeyActivatedButton)
        ;(bulk as unknown as { OnKeyDown(a: unknown): void }).OnKeyDown({ Key: Key.Return, Handled: false })
        assert.deepEqual(received, [[Fixtures.Alice]])
        t.ToggleSelect(Fixtures.Alice)
        assert.equal(t.Selection.length, 0)
        assert.equal(bulkLabel(), undefined)
    })

    it('FocusRow and ActivateFocused call onOpen with the focused row', () =>
    {
        const opened: Row[] = []
        const t = Fixtures.Make({ onOpen: r => opened.push(r) })
        t.SortBy('name')
        t.FocusRow(1)
        assert.equal(t.FocusedIndex, 1)
        t.ActivateFocused()
        assert.deepEqual(opened, [Fixtures.Bob])
    })

    it('keyboard: j/k move focus, Enter opens, slash focuses search', () =>
    {
        const opened: Row[] = []
        const t = Fixtures.Make({ onOpen: r => opened.push(r) })
        t.SortBy('name')
        Fixtures.Press(t, Key.J, 'j')
        assert.equal(t.FocusedIndex, 0)
        Fixtures.Press(t, Key.J, 'j')
        assert.equal(t.FocusedIndex, 1)
        Fixtures.Press(t, Key.K, 'k')
        assert.equal(t.FocusedIndex, 0)
        Fixtures.Press(t, Key.K, 'k')
        assert.equal(t.FocusedIndex, 0)
        Fixtures.Press(t, Key.Return, '')
        assert.deepEqual(opened, [Fixtures.Alice])
        Fixtures.Press(t, Key.Oem2, '/')
    })
})
