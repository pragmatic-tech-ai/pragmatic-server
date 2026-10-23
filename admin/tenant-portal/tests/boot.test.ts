import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TenantPortalMain } from '../src/main.js'
import { PlaceholderRootView } from '../src/placeholder-root-view.js'

class Fixtures
{
    // Every TextBlock text in the visual tree, following Children and Button.Content.
    public static Texts(node: unknown): string[]
    {
        const n = node as { Text?: unknown; Children?: Iterable<unknown>; Content?: unknown }
        const out: string[] = []
        if (typeof n.Text === 'string')
        {
            out.push(n.Text)
        }
        if (n.Content !== undefined && n.Content !== null)
        {
            out.push(...Fixtures.Texts(n.Content))
        }
        if (n.Children !== undefined)
        {
            for (const c of n.Children)
            {
                out.push(...Fixtures.Texts(c))
            }
        }
        return out
    }
}

describe('TenantPortalMain boot', () =>
{
    it('exposes a static Run entry point', () =>
    {
        assert.equal(typeof TenantPortalMain.Run, 'function')
    })

    it('the placeholder root view shows the title text', () =>
    {
        const view = new PlaceholderRootView()
        assert.ok(Fixtures.Texts(view).includes(PlaceholderRootView.TitleText))
    })
})
