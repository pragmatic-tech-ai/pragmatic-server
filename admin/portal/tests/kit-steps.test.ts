import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { FontWeight } from '@pragmatic-tech-ai/mural/visual-engine'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { Steps } from '../src/kit/index.js'

class Fixtures
{
    private static readonly Labels: readonly string[] = ['Account', 'Region', 'Confirm']
    private static readonly ContentText = 'Body'

    public static StepLabels(): readonly string[]
    {
        return Fixtures.Labels
    }

    public static ExpectedContent(): string
    {
        return Fixtures.ContentText
    }

    public static Blocks(node: unknown): TextBlock[]
    {
        return Fixtures.Collect(node).filter(n => n instanceof TextBlock).map(n => n as TextBlock)
    }

    public static Content(): TextBlock
    {
        const content = new TextBlock()
        content.Text = Fixtures.ContentText
        return content
    }

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
}

describe('kit Steps', () =>
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

    it('Steps renders its labels and marks the current step active, with the content below', () =>
    {
        const labels = Fixtures.StepLabels()
        const current = 1
        const steps = new Steps({ steps: labels, current, content: Fixtures.Content() })
        const texts = Fixtures.Texts(steps)
        for (const label of labels)
        {
            assert.ok(texts.includes(label), label)
        }
        assert.equal(steps.ActiveIndex, current)
        assert.ok(texts.includes(Fixtures.ExpectedContent()))
        assert.ok(steps instanceof StackPanel)
        const blocks = Fixtures.Blocks(steps)
        const activeBlock = blocks.find(b => b.Text === labels[current])
        assert.equal(activeBlock?.FontWeight, FontWeight.Bold)
        const inactiveBlock = blocks.find(b => b.Text === labels[0])
        assert.equal(inactiveBlock?.FontWeight, FontWeight.Normal)
    })
})
