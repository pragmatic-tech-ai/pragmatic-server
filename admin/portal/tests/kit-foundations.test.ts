import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Key, Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { Act, KeyActivatedButton, PillKind, PillKinds, StatusPill } from '../src/kit/index.js'
import { IconCatalog, KitGlyph } from '../src/kit/icon-catalog.js'

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

    public static Click(b: KeyActivatedButton): void
    {
        b.Press()
    }

    public static Press(b: KeyActivatedButton, key: Key): void
    {
        (b as unknown as { OnKeyDown(a: unknown): void }).OnKeyDown({ Key: key, Handled: false })
    }
}

describe('kit foundations', () =>
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

    it('PillKinds.For covers every PillKind with a glyph and non-empty label', () =>
    {
        const kinds = Object.values(PillKind)
        assert.equal(kinds.length, 18)
        for (const kind of kinds)
        {
            const entry = PillKinds.For(kind)
            assert.ok(entry.label.length > 0, String(kind))
            assert.notEqual(entry.glyph, undefined, String(kind))
        }
    })

    it('StatusPill renders the label and honors LabelOverride', () =>
    {
        const pill = new StatusPill(PillKind.Awaiting)
        assert.equal(pill.Kind, PillKind.Awaiting)
        assert.deepEqual(Fixtures.Texts(pill), [PillKinds.For(PillKind.Awaiting).label])
        pill.LabelOverride = 'Custom'
        assert.deepEqual(Fixtures.Texts(pill), ['Custom'])
    })

    it('KeyActivatedButton is focusable and activates exactly once per click / Enter / Space', () =>
    {
        let count = 0
        const b = new KeyActivatedButton(() => { count++ })
        assert.equal(b.Focusable, true)
        Fixtures.Click(b)
        assert.equal(count, 1)
        Fixtures.Press(b, Key.Return)
        assert.equal(count, 2)
        Fixtures.Press(b, Key.Space)
        assert.equal(count, 3)
    })

    it('KeyActivatedButton.Press invokes onActivate exactly once', () =>
    {
        let count = 0
        const b = new KeyActivatedButton(() => { count++ })
        b.Press()
        assert.equal(count, 1)
    })

    it('KeyActivatedButton.Press without onActivate does not throw', () =>
    {
        const b = new KeyActivatedButton()
        assert.doesNotThrow(() => b.Press())
    })

    it('enabled Act.Press calls onClick once', () =>
    {
        let count = 0
        const act = new Act({ can: true, label: 'Go', onClick: () => { count++ } })
        act.Press()
        assert.equal(count, 1)
    })

    it('disabled Act.Press does NOT call onClick (gate)', () =>
    {
        let count = 0
        const act = new Act({ can: false, label: 'Go', onClick: () => { count++ } })
        act.Press()
        assert.equal(count, 0)
    })

    it('resolves a definition for every nav and top-bar glyph', () =>
    {
        const glyphs = [KitGlyph.Server, KitGlyph.Building, KitGlyph.Users, KitGlyph.HardDrive, KitGlyph.Package, KitGlyph.Shield, KitGlyph.Layers, KitGlyph.Settings]
        for (const g of glyphs)
        {
            const def = IconCatalog.Definition(g)
            assert.ok(def !== undefined, String(g))
        }
    })
})
