import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Button, ToolTipService } from '@pragmatic-tech-ai/mural/framework'
import { Application, Style } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { IdentityPlate } from '../src/identity-plate.js'
import { TopBar } from '../src/top-bar.js'
import { UserMenu } from '../src/user-menu.js'

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

describe('top bar', () =>
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

    it('plate shows org, separator, tenant and hive when org is set', () =>
    {
        const texts = Walk.Texts(new IdentityPlate({ org: 'Acme', tenant: 'Prod', hive: 'hive-1' }))
        assert.deepEqual(texts, ['Acme', '/', 'Prod', 'hive-1'])
    })

    it('plate omits org and the separator when org is undefined or empty', () =>
    {
        for (const org of [undefined, ''])
        {
            const texts = Walk.Texts(new IdentityPlate({ org, tenant: 'Prod', hive: 'hive-1' }))
            assert.deepEqual(texts, ['Prod', 'hive-1'])
            assert.ok(!texts.includes(IdentityPlate.Separator))
        }
    })

    it('plate has no interactive control and carries the hover title', () =>
    {
        const plate = new IdentityPlate({ org: 'Acme', tenant: 'Prod', hive: 'hive-1' })
        assert.equal(Walk.Buttons(plate).length, 0)
        assert.equal(ToolTipService.GetToolTip(plate), IdentityPlate.HoverTitle)
    })

    it('plate renders the hive id with the theme mono style', () =>
    {
        const plate = new IdentityPlate({ tenant: 'Prod', hive: 'hive-1' })
        const hive = Walk.Collect(plate).find(n => n instanceof TextBlock && n.Text === 'hive-1') as TextBlock
        const code = Application.ResolveDefaultResource<Style>('Code')
        assert.ok(code instanceof Style)
        assert.equal(hive.Style, code)
    })

    it('user menu shows email, initials and a Logout that invokes onLogout', () =>
    {
        let calls = 0
        const menu = new UserMenu({ email: 'jane.doe@acme.com', onLogout: () => { calls++ } })
        const texts = Walk.Texts(menu)
        assert.ok(texts.includes('jane.doe@acme.com'))
        assert.ok(texts.includes('JD'))
        assert.equal(Walk.Buttons(menu).length, 1)
        menu.LogoutAction.Press()
        assert.equal(calls, 1)
    })

    it('user menu shows a role line only when roleLabel is given', () =>
    {
        const withRole = Walk.Texts(new UserMenu({ email: 'a@b.c', roleLabel: 'Tenant owner', onLogout: () => {} }))
        assert.ok(withRole.includes('Tenant owner'))
        const without = Walk.Texts(new UserMenu({ email: 'a@b.c', onLogout: () => {} }))
        assert.ok(!without.includes('Tenant owner'))
        assert.equal(without.length, withRole.length - 1)
    })

    it('user menu with an empty roleLabel renders no role line, same as undefined', () =>
    {
        const empty = Walk.Texts(new UserMenu({ email: 'a@b.c', roleLabel: '', onLogout: () => {} }))
        const absent = Walk.Texts(new UserMenu({ email: 'a@b.c', onLogout: () => {} }))
        assert.deepEqual(empty, absent)
    })

    it('top bar contains plate and user menu and starts with an empty banner slot', () =>
    {
        const plate = new IdentityPlate({ tenant: 'Prod', hive: 'hive-1' })
        const menu = new UserMenu({ email: 'a@b.c', onLogout: () => {} })
        const bar = new TopBar({ plate, userMenu: menu, onActivity: () => {} })
        const all = Walk.Collect(bar)
        assert.ok(all.includes(plate))
        assert.ok(all.includes(menu))
        assert.equal([...bar.BannerSlot.Children].length, 0)
        assert.equal(bar.BarSurface, Application.ResolveDefaultResource(TopBar.SurfaceKey))
    })
})
