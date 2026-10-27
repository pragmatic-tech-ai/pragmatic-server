import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import * as Kit from '../../src/kit/index.js'
import { KeyValueGrid, Section } from '../../src/kit/index.js'

class Walk
{
    public static Collect(node: unknown, out: unknown[] = []): unknown[]
    {
        out.push(node)
        const children = (node as { Children?: Iterable<unknown> }).Children
        if (children !== undefined)
        {
            for (const c of children)
            {
                Walk.Collect(c, out)
            }
        }
        return out
    }

    public static Texts(node: unknown): string[]
    {
        return Walk.Collect(node).filter(n => n instanceof TextBlock).map(n => (n as TextBlock).Text)
    }
}

describe('Section and KeyValueGrid', () =>
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

    it('Section renders title, sub, actions and body', () =>
    {
        const actions = new TextBlock()
        actions.Text = 'ACT'
        const body = new TextBlock()
        body.Text = 'BODY'
        const section = new Section({ title: 'T', sub: 'S', actions, body })
        assert.deepEqual(Walk.Texts(section), ['T', 'S', 'ACT', 'BODY'])
    })

    it('Section omits absent sub and actions', () =>
    {
        const body = new TextBlock()
        body.Text = 'BODY'
        assert.deepEqual(Walk.Texts(new Section({ title: 'T', body })), ['T', 'BODY'])
    })

    it('KeyValueGrid lays out items in cols columns', () =>
    {
        const extra = new TextBlock()
        extra.Text = 'V3'
        const grid = new KeyValueGrid({
            items: [{ key: 'K1', value: 'V1' }, { key: 'K2', value: 'V2' }, { key: 'K3', value: extra }],
            cols: 2,
        })
        const rows = [...grid.Children] as StackPanel[]
        assert.equal(rows.length, 2)
        assert.equal([...rows[0].Children].length, 2)
        assert.equal([...rows[1].Children].length, 1)
        assert.deepEqual(Walk.Texts(grid), ['K1', 'V1', 'K2', 'V2', 'K3', 'V3'])
    })

    it('KeyValueGrid defaults to two columns', () =>
    {
        const items = [{ key: 'a', value: '1' }, { key: 'b', value: '2' }, { key: 'c', value: '3' }]
        assert.equal([...new KeyValueGrid({ items }).Children].length, 2)
        assert.equal([...new KeyValueGrid({ items, cols: 1 }).Children].length, 3)
    })

    it('KeyValueGrid sanitizes cols without dropping items', () =>
    {
        const items = [{ key: 'a', value: '1' }, { key: 'b', value: '2' }, { key: 'c', value: '3' }]
        const rowCount = (cols: number): number => [...new KeyValueGrid({ items, cols }).Children].length
        assert.equal(rowCount(0), 3)
        assert.equal(rowCount(2.5), 2)
        assert.equal(rowCount(Number.NaN), 2)
        assert.equal(rowCount(Number.POSITIVE_INFINITY), 2)
        assert.deepEqual(Walk.Texts(new KeyValueGrid({ items, cols: Number.NaN })), ['a', '1', 'b', '2', 'c', '3'])
    })

    it('barrel re-exports the kit surface', () =>
    {
        const expected = [
            'KitGlyph', 'IconCatalog', 'PillTone', 'Tones', 'PillKind', 'PillKinds', 'StatusPill',
            'ScreenState', 'ScreenHost', 'SkeletonKind', 'SkeletonPanel', 'EmptyStatePanel',
            'ErrorStatePanel', 'DeniedStatePanel', 'ConfirmDialog', 'ConfirmTone', 'Act', 'ActVariant',
            'Section', 'KeyValueGrid',
        ]
        const surface = Kit as unknown as Record<string, unknown>
        for (const name of expected)
        {
            assert.notEqual(surface[name], undefined, name)
        }
    })
})
