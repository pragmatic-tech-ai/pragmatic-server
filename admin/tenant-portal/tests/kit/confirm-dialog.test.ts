import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { ConfirmDialog } from '../../src/kit/confirm-dialog.js'

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
})
