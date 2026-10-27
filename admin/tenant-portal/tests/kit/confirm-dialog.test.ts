import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { Application, type Visual } from '@pragmatic-tech-ai/mural/runtime'
import { HeadlessTarget } from '@pragmatic-tech-ai/mural/visual-engine'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { ConfirmDialog } from '../../src/kit/confirm-dialog.js'

class Tree
{
    public static Collect<T>(root: Visual, type: new (...a: never[]) => T, out: T[] = []): T[]
    {
        if (root instanceof type)
        {
            out.push(root)
        }
        for (const c of (root as unknown as { visualChildren?: readonly Visual[] }).visualChildren ?? [])
        {
            Tree.Collect(c, type, out)
        }
        return out
    }

    public static Label(button: Button): string | undefined
    {
        return Tree.Collect(button, TextBlock)[0]?.Text
    }
}

class Harness
{
    public readonly calls: string[] = []

    public Make(confirmName?: string, consequences?: string[]): ConfirmDialog
    {
        return new ConfirmDialog({
            title: 'Delete env',
            body: 'This is permanent.',
            consequences,
            confirmName,
            actionLabel: 'Delete',
            onConfirm: () => { this.calls.push('confirm') },
            onClose: () => { this.calls.push('close') },
        })
    }
}

describe('ConfirmDialog', () =>
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

    it('requires an exact name match', () =>
    {
        const d = new Harness().Make('prod')
        assert.equal(d.Title, 'Delete env')
        assert.equal(d.ConfirmEnabled, false)
        for (const bad of ['', 'PROD', 'Prod', 'prod ', ' prod', 'pro'])
        {
            d.SetTyped(bad)
            assert.equal(d.ConfirmEnabled, false, JSON.stringify(bad))
        }
        d.SetTyped('prod')
        assert.equal(d.ConfirmEnabled, true)
    })

    it('does not fire confirm while mismatched', () =>
    {
        const h = new Harness()
        const d = h.Make('prod')
        d.SetTyped('PROD')
        d.Confirm()
        assert.deepEqual(h.calls, [])
    })

    it('confirm fires onConfirm then onClose on exact match', () =>
    {
        const h = new Harness()
        const d = h.Make('prod')
        d.SetTyped('prod')
        d.Confirm()
        assert.deepEqual(h.calls, ['confirm', 'close'])
    })

    it('is enabled immediately without a confirmName', () =>
    {
        const h = new Harness()
        const d = h.Make()
        assert.equal(d.ConfirmEnabled, true)
        d.Confirm()
        assert.deepEqual(h.calls, ['confirm', 'close'])
    })

    it('renders each consequence and the type prompt', () =>
    {
        const d = new Harness().Make('prod', ['Drops data', 'Revokes tokens'])
        assert.ok(d.Lines.some(l => l.includes('Drops data')))
        assert.ok(d.Lines.some(l => l.includes('Revokes tokens')))
        assert.ok(d.Lines.includes('Type prod to confirm'))
    })

    it('Cancel invokes onClose only', () =>
    {
        const h = new Harness()
        h.Make('prod').Cancel()
        assert.deepEqual(h.calls, ['close'])
    })

    it('rendered confirm button enables reactively as the real TextBox changes', () =>
    {
        const d = new Harness().Make('prod')
        const target = new HeadlessTarget(600, 400)
        target.Content = d
        target.Flush()
        const confirm = Tree.Collect(d, Button).find(b => Tree.Label(b) === 'Delete')
        assert.notEqual(confirm, undefined)
        const box = Tree.Collect(d, TextBox)[0]
        assert.notEqual(box, undefined)
        assert.equal(confirm!.IsEnabled, false)
        box.Text = 'PROD'
        assert.equal(confirm!.IsEnabled, false)
        box.Text = 'prod'
        assert.equal(confirm!.IsEnabled, true)
        box.Text = ''
        assert.equal(confirm!.IsEnabled, false)
    })

    it('renders a TextBlock per consequence', () =>
    {
        const d = new Harness().Make('prod', ['Drops data', 'Revokes tokens'])
        const target = new HeadlessTarget(600, 400)
        target.Content = d
        target.Flush()
        const texts = Tree.Collect(d, TextBlock).map(t => t.Text)
        assert.ok(texts.some(t => t.includes('Drops data')))
        assert.ok(texts.some(t => t.includes('Revokes tokens')))
    })
})
