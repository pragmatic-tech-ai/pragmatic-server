import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { OnceSecret } from '../src/kit/index.js'

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

    public static Texts(node: unknown): string[]
    {
        const out: string[] = []
        for (const n of Fixtures.Collect(node))
        {
            if (n instanceof TextBlock || n instanceof TextBox)
            {
                out.push(n.Text)
            }
        }
        return out
    }

    public static Click(b: Button): void
    {
        for (const h of (b as unknown as { _clickHandlers: Array<(a: unknown) => void> })._clickHandlers)
        {
            h({})
        }
    }
}

describe('OnceSecret', () =>
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

    it('OnceSecret renders the title, value and hint', () =>
    {
        const s = new OnceSecret({ title: 'API token', value: 'pmt_abc', hint: 'Expires in 90 days.', onDone: () => {} })
        assert.equal(s.Value, 'pmt_abc')
        const texts = Fixtures.Texts(s)
        assert.ok(texts.includes('API token'))
        assert.ok(texts.includes('Expires in 90 days.'))
        assert.equal(Fixtures.Buttons(s).length, 1)
    })

    it('PressStore calls onDone exactly once and marks Stored', () =>
    {
        let calls = 0
        const s = new OnceSecret({ title: 'T', value: 'v', onDone: () => { calls++ } })
        assert.equal(s.Stored, false)
        s.PressStore()
        assert.equal(s.Stored, true)
        assert.equal(calls, 1)
        s.PressStore()
        assert.equal(calls, 1)
    })

    it('clicking the button behaves like PressStore', () =>
    {
        let calls = 0
        const s = new OnceSecret({ title: 'T', value: 'v', onDone: () => { calls++ } })
        Fixtures.Click(Fixtures.Buttons(s)[0])
        assert.equal(calls, 1)
        assert.equal(s.Stored, true)
    })

    it('the value is not exposed after storing', () =>
    {
        const s = new OnceSecret({ title: 'T', value: 'pmt_abc', onDone: () => {} })
        s.PressStore()
        assert.equal(s.Value, '')
        assert.ok(!Fixtures.Texts(s).some(x => x.includes('pmt_abc')))
    })
})
