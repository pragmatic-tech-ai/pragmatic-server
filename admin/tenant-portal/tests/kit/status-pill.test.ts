import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Icon, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { IconCatalog, KitGlyph } from '../../src/kit/icon-catalog.js'
import { PillKind, PillKinds } from '../../src/kit/pill-kinds.js'
import { StatusPill } from '../../src/kit/status-pill.js'
import { PillTone, Tones } from '../../src/kit/tones.js'

class Walk
{
    public static Collect(node: unknown, out: unknown[] = []): unknown[]
    {
        out.push(node)
        const children = (node as { Children?: Iterable<unknown> }).Children
        if (children !== undefined)
        {
            for (const c of children)
            {
                Walk.Collect(c, out)
            }
        }
        return out
    }
}

describe('StatusPill', () =>
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

    for (const kind of Object.values(PillKind))
    {
        it(`renders icon + label for ${kind}`, () =>
        {
            const entry = PillKinds.Entry(kind)
            const nodes = Walk.Collect(new StatusPill(kind))
            const icon = nodes.find(n => n instanceof Icon) as Icon
            const text = nodes.find(n => n instanceof TextBlock) as TextBlock
            assert.equal(icon.Source, IconCatalog.Definition(entry.glyph))
            assert.equal(icon.Foreground, Tones.Brush(entry.tone))
            assert.equal(icon.Recolor, true)
            assert.equal(text.Text, entry.label)
        })
    }

    it('rebuilds on Kind change leaving exactly one icon and one text', () =>
    {
        const pill = new StatusPill(PillKind.Healthy)
        pill.Kind = PillKind.Failing
        const nodes = Walk.Collect(pill)
        assert.equal(nodes.filter(n => n instanceof Icon).length, 1)
        assert.equal(nodes.filter(n => n instanceof TextBlock).length, 1)
        assert.equal((nodes.find(n => n instanceof Icon) as Icon).Source, IconCatalog.Definition(KitGlyph.CircleAlert))
        assert.equal((nodes.find(n => n instanceof TextBlock) as TextBlock).Text, 'Failing')
    })

    it('LabelOverride changes only the label', () =>
    {
        const pill = new StatusPill(PillKind.Failing)
        pill.LabelOverride = 'Custom'
        const nodes = Walk.Collect(pill)
        const icon = nodes.find(n => n instanceof Icon) as Icon
        assert.equal((nodes.find(n => n instanceof TextBlock) as TextBlock).Text, 'Custom')
        assert.equal(icon.Source, IconCatalog.Definition(KitGlyph.CircleAlert))
        assert.equal(icon.Foreground, Tones.Brush(PillTone.Danger))
        assert.equal(nodes.filter(n => n instanceof Icon).length, 1)
        assert.equal(nodes.filter(n => n instanceof TextBlock).length, 1)
    })

    it('labels equal their literal design strings', () =>
    {
        assert.equal(PillKinds.Entry(PillKind.Observed).label, 'Observed \u2014 read-only')
        assert.equal(PillKinds.Entry(PillKind.Connected).label, 'Connected')
        assert.equal(PillKinds.Entry(PillKind.Never).label, 'Never dialled in')
        assert.equal(PillKinds.Entry(PillKind.Gated).label, 'Gated out')
    })

    it('falls back for an unknown kind without throwing', () =>
    {
        const bogus = 'bogus' as PillKind
        const entry = PillKinds.Entry(bogus)
        assert.equal(entry.tone, PillTone.Neutral)
        assert.equal(entry.glyph, KitGlyph.CircleDashed)
        assert.equal(entry.label, 'bogus')
        const text = Walk.Collect(new StatusPill(bogus)).find(n => n instanceof TextBlock) as TextBlock
        assert.equal(text.Text, 'bogus')
    })
})
