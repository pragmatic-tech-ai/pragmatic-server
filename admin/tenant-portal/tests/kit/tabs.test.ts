import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { Tabs } from '../../src/kit/index.js'

class Fixtures
{
    public static Block(text: string): TextBlock
    {
        const t = new TextBlock()
        t.Text = text
        return t
    }
}

describe('Tabs', () =>
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

    it('starts on the first tab showing its content', () =>
    {
        const a = Fixtures.Block('A')
        const tabs = new Tabs({ entries: [{ label: 'One', content: a }, { label: 'Two', content: Fixtures.Block('B') }, { label: 'Three', content: Fixtures.Block('C') }] })
        assert.equal(tabs.ActiveIndex, 0)
        assert.equal(tabs.ActiveContent, a)
        assert.equal([...tabs.ContentHost.Children].length, 1)
    })

    it('Select swaps the visible content', () =>
    {
        const c = Fixtures.Block('C')
        const tabs = new Tabs({ entries: [{ label: 'One', content: Fixtures.Block('A') }, { label: 'Two', content: Fixtures.Block('B') }, { label: 'Three', content: c }] })
        tabs.Select(2)
        assert.equal(tabs.ActiveIndex, 2)
        assert.equal(tabs.ActiveContent, c)
        assert.equal([...tabs.ContentHost.Children].length, 1)
    })

    it('Select on the current index is a no-op', () =>
    {
        let calls = 0
        const tabs = new Tabs({ entries: [{ label: 'One', content: Fixtures.Block('A') }, { label: 'Two', content: Fixtures.Block('B') }], onSelect: () => { calls++ } })
        tabs.Select(0)
        assert.equal([...tabs.ContentHost.Children].length, 1)
        assert.equal(calls, 0)
    })

    it('onSelect fires on a real switch', () =>
    {
        const seen: number[] = []
        const tabs = new Tabs({ entries: [{ label: 'One', content: Fixtures.Block('A') }, { label: 'Two', content: Fixtures.Block('B') }], onSelect: i => seen.push(i) })
        tabs.Select(1)
        assert.deepEqual(seen, [1])
    })

    it('ignores out-of-range indices', () =>
    {
        const tabs = new Tabs({ entries: [{ label: 'One', content: Fixtures.Block('A') }] })
        tabs.Select(5)
        assert.equal(tabs.ActiveIndex, 0)
    })
})
