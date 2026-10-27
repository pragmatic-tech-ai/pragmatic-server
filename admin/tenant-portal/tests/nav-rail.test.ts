import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Icon, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { IconCatalog, KitGlyph } from '../src/kit/icon-catalog.js'
import { NavModel, NavSection } from '../src/nav-model.js'
import { NavRail } from '../src/nav-rail.js'

class Walk
{
    public static Collect(node: unknown, out: unknown[] = []): unknown[]
    {
        out.push(node)
        const content = (node as { Content?: unknown }).Content
        if (content !== undefined && content !== null && typeof content === 'object')
        {
            Walk.Collect(content, out)
        }
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

    public static Buttons(root: unknown): Button[]
    {
        return Walk.Collect(root).filter(n => n instanceof Button) as Button[]
    }

    public static Texts(root: unknown): string[]
    {
        return Walk.Collect(root).filter(n => n instanceof TextBlock).map(n => (n as TextBlock).Text)
    }
}

describe('NavModel', () =>
{
    it('lists the six sections in order with labels and glyphs', () =>
    {
        const expected: Array<[NavSection, string, KitGlyph]> = [
            [NavSection.Overview, 'Overview', KitGlyph.Home],
            [NavSection.Environments, 'Environments', KitGlyph.Layers],
            [NavSection.UsersAccess, 'Users & Access', KitGlyph.Users],
            [NavSection.Releases, 'Releases', KitGlyph.Package],
            [NavSection.Settings, 'Settings', KitGlyph.Settings],
            [NavSection.ConnectionStatus, 'Connection status', KitGlyph.RadioTower],
        ]
        assert.deepEqual(NavModel.Items.map(i => [i.Section, i.Label, i.Glyph]), expected)
    })

    it('ActiveFor is identity for every section', () =>
    {
        for (const item of NavModel.Items)
        {
            assert.equal(NavModel.ActiveFor(item.Section), item.Section)
        }
    })
})

describe('NavRail', () =>
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

    it('renders brand, six item rows with icon and label, and footer', () =>
    {
        const rail = new NavRail(() => { })
        const texts = Walk.Texts(rail)
        assert.ok(texts.includes(NavRail.BrandText))
        assert.ok(texts.includes(NavRail.FooterText))
        const buttons = Walk.Buttons(rail)
        assert.equal(buttons.length, 6)
        buttons.forEach((b, i) =>
        {
            const item = NavModel.Items[i]
            assert.deepEqual(Walk.Texts(b), [item.Label])
            const icon = Walk.Collect(b).find(n => n instanceof Icon) as Icon
            assert.equal(icon.Source, IconCatalog.Definition(item.Glyph))
        })
    })

    it('SetActive marks exactly one item current', () =>
    {
        const rail = new NavRail(() => { })
        rail.SetActive(NavSection.Releases)
        const current = Walk.Buttons(rail).filter(b => b.Tag === NavRail.CurrentRole)
        assert.equal(current.length, 1)
        assert.deepEqual(Walk.Texts(current[0]), ['Releases'])
        rail.SetActive(NavSection.Overview)
        const again = Walk.Buttons(rail).filter(b => b.Tag === NavRail.CurrentRole)
        assert.equal(again.length, 1)
        assert.deepEqual(Walk.Texts(again[0]), ['Overview'])
    })

    it('activating an item invokes onSelect with its section', () =>
    {
        const picked: NavSection[] = []
        const rail = new NavRail(s => picked.push(s))
        const button = Walk.Buttons(rail)[2]
        for (const h of (button as unknown as { _clickHandlers: Array<(a: unknown) => void> })._clickHandlers)
        {
            h({})
        }
        assert.deepEqual(picked, [NavSection.UsersAccess])
    })
})
