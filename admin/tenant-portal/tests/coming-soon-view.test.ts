import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { ComingSoonView } from '../src/coming-soon-view.js'
import { EmptyStatePanel, ScreenState } from '../src/kit/index.js'

class Walk
{
    public static Collect(node: unknown, out: unknown[] = []): unknown[]
    {
        out.push(node)
        for (const c of (node as { Children?: Iterable<unknown> }).Children ?? [])
        {
            Walk.Collect(c, out)
        }
        return out
    }
}

describe('ComingSoonView', () =>
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

    it('renders the kit empty state with the title and body', () =>
    {
        const view = new ComingSoonView('Releases')
        assert.equal(view.Host.State, ScreenState.Empty)
        const nodes = Walk.Collect(view)
        assert.ok(nodes.some(n => n instanceof EmptyStatePanel))
        const texts = nodes.filter(n => n instanceof TextBlock).map(n => (n as TextBlock).Text)
        assert.ok(texts.includes('Releases'))
        assert.ok(texts.includes(ComingSoonView.BodyText))
    })
})
