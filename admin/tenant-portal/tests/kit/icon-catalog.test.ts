import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { IconDefinition } from '@pragmatic-tech-ai/mural/basic'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { IconCatalog, KitGlyph } from '../../src/kit/icon-catalog.js'
import { PillTone, Tones } from '../../src/kit/tones.js'

class Fixtures
{
    public static Themed(): Application
    {
        const app = new Application()
        Application.current = app
        app.initialize({ theme: Pragmatic, scheme: PragmaticLight })
        return app
    }
}

describe('IconCatalog', () =>
{
    for (const glyph of Object.values(KitGlyph))
    {
        it(`builds a cached definition for ${glyph}`, () =>
        {
            const def = IconCatalog.Definition(glyph)
            assert.ok(def instanceof IconDefinition)
            assert.ok(def.Shapes.length >= 1)
            assert.equal(IconCatalog.Definition(glyph), def)
        })
    }
})

describe('Tones', () =>
{
    let previous: Application | null

    before(() =>
    {
        previous = Application.current
        Fixtures.Themed()
    })

    after(() =>
    {
        Application.current = previous
    })

    for (const tone of [PillTone.Success, PillTone.Warning, PillTone.Danger, PillTone.Info, PillTone.Neutral])
    {
        it(`resolves brushes for ${PillTone[tone]}`, () =>
        {
            assert.notEqual(Tones.Brush(tone), undefined)
            assert.notEqual(Tones.SoftBrush(tone), undefined)
        })
    }

    it('throws naming the key when no themed Application is current', () =>
    {
        const themed = Application.current
        Application.current = null
        try
        {
            assert.throws(() => Tones.Brush(PillTone.Success), new RegExp(Tones.MissingBrushMessage + 'StateSuccess'))
        }
        finally
        {
            Application.current = themed
        }
    })
})
