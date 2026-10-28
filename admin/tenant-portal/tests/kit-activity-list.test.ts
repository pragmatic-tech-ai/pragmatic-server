import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { ActivityList, PillKind } from '../src/kit/index.js'
import type { ActivityListItem } from '../src/kit/index.js'

class Fixtures
{
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

    public static Item(summary: string): ActivityListItem
    {
        return { Summary: summary, Pill: PillKind.Healthy, RelativeTime: () => `${summary}-ago` }
    }
}

describe('ActivityList', () =>
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

    it('renders one row per entry in order', () =>
    {
        const list = new ActivityList({ entries: [Fixtures.Item('a'), Fixtures.Item('b'), Fixtures.Item('c')], emptyText: 'none' })
        assert.equal(list.Rows.length, 3)
        assert.equal(list.IsEmpty, false)
        const texts = Fixtures.Texts(list)
        assert.ok(texts.indexOf('a') < texts.indexOf('b') && texts.indexOf('b') < texts.indexOf('c'))
        assert.ok(texts.includes('a-ago'))
    })

    it('caps rows at max', () =>
    {
        const list = new ActivityList({ entries: [Fixtures.Item('a'), Fixtures.Item('b'), Fixtures.Item('c')], max: 2, emptyText: 'none' })
        assert.equal(list.Rows.length, 2)
    })

    it('renders the empty text when there are no entries', () =>
    {
        const list = new ActivityList({ entries: [], emptyText: 'Nothing yet' })
        assert.equal(list.IsEmpty, true)
        assert.equal(list.Rows.length, 0)
        assert.deepEqual(Fixtures.Texts(list), ['Nothing yet'])
    })

    it('Update re-renders in place', () =>
    {
        const list = new ActivityList({ entries: [], emptyText: 'none' })
        list.Update({ entries: [Fixtures.Item('x')], emptyText: 'none' })
        assert.equal(list.IsEmpty, false)
        assert.equal(list.Rows.length, 1)
        assert.ok(!Fixtures.Texts(list).includes('none'))
    })
})
