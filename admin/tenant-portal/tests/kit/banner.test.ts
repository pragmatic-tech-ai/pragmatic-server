import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { Banner, BannerTone } from '../../src/kit/index.js'

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

describe('Banner', () =>
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

    it('reports tone and renders text', () =>
    {
        const banner = new Banner({ tone: BannerTone.Danger, text: 'Broken' })
        assert.equal(banner.Tone, BannerTone.Danger)
        assert.equal(banner.Text, 'Broken')
        const texts = Fixtures.Collect(banner).filter(n => n instanceof TextBlock).map(n => (n as TextBlock).Text)
        assert.ok(texts.includes('Broken'))
        assert.ok(texts.length >= 2, 'tone label accompanies text')
    })

    it('action button invokes callback once per click', () =>
    {
        let calls = 0
        const banner = new Banner({ tone: BannerTone.Info, text: 'Hi', actionLabel: 'Fix', onAction: () => { calls++ } })
        const buttons = Fixtures.Buttons(banner)
        assert.equal(buttons.length, 1)
        Fixtures.Click(buttons[0])
        assert.equal(calls, 1)
    })

    it('has no action button without actionLabel', () =>
    {
        const banner = new Banner({ tone: BannerTone.Warning, text: 'Hi' })
        assert.equal(Fixtures.Buttons(banner).length, 0)
    })
})
