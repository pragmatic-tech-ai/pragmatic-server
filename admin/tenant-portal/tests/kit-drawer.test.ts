import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { Drawer } from '../src/kit/index.js'

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

    public static Buttons(node: unknown): Button[]
    {
        return Fixtures.Collect(node).filter(n => n instanceof Button) as Button[]
    }

    public static Click(b: Button): void
    {
        for (const h of (b as unknown as { _clickHandlers: Array<(a: unknown) => void> })._clickHandlers)
        {
            h({})
        }
    }
}

describe('Drawer', () =>
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

    it('shows no body while closed', () =>
    {
        const body = new TextBlock()
        const drawer = new Drawer({ title: 'Activity', body, open: false, closeLabel: 'Close', onClose: () => undefined })
        assert.equal(drawer.Open, false)
        assert.equal(Fixtures.Collect(drawer).includes(body), false)
        assert.equal([...drawer.BodyHost.Children].length, 0)
    })

    it('SetOpen(true) shows the body and Toggle flips', () =>
    {
        const body = new TextBlock()
        const drawer = new Drawer({ title: 'Activity', body, open: false, closeLabel: 'Close', onClose: () => undefined })
        drawer.SetOpen(true)
        assert.equal(drawer.Open, true)
        assert.ok(Fixtures.Collect(drawer).includes(body))
        assert.ok(drawer.BodyHost instanceof StackPanel)
        drawer.Toggle()
        assert.equal(drawer.Open, false)
        assert.equal(Fixtures.Collect(drawer).includes(body), false)
        drawer.Toggle()
        assert.ok(Fixtures.Collect(drawer).includes(body))
    })

    it('close affordance invokes onClose', () =>
    {
        let closes = 0
        const drawer = new Drawer({ title: 'Activity', body: new TextBlock(), open: true, closeLabel: 'Close', onClose: () => { closes++ } })
        const buttons = Fixtures.Buttons(drawer)
        assert.equal(buttons.length, 1)
        Fixtures.Click(buttons[0])
        assert.equal(closes, 1)
    })
})
