import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Application, Key, ThemeManager } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticDark, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { PaSection } from '../src/nav-model.js'
import { ThemeScheme, TopBar } from '../src/top-bar.js'

class Fixtures
{
    public static Make(jumps: PaSection[], logouts: number[], legacies: number[] = []): TopBar
    {
        return new TopBar({
            context: 'Platform',
            operatorEmail: 'op@example.com',
            onJump: s => { jumps.push(s) },
            onLogout: () => { logouts.push(1) },
            onLegacy: () => { legacies.push(1) },
        })
    }

    // Drives the bar's routed KeyDown handler directly (the kit tests use the same cast for OnKeyDown).
    public static Enter(tb: TopBar, key: Key = Key.Return, handled = false): void
    {
        (tb as unknown as { OnEnterKey(args: { Key: Key; Handled: boolean }): void }).OnEnterKey({ Key: key, Handled: handled })
    }
}

describe('PA top bar', () =>
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

    it('search resolves unambiguous queries to sections', () =>
    {
        const jumps: PaSection[] = []
        const tb = Fixtures.Make(jumps, [])
        tb.SetSearch('policy')
        tb.Jump()
        tb.SetSearch('HIVES')
        tb.Jump()
        tb.SetSearch('channel')
        tb.Jump()
        assert.deepEqual(jumps, [PaSection.ReleasePolicy, PaSection.Hives, PaSection.AgentChannel])
        assert.equal(tb.SearchText, 'channel')
    })

    it('empty and unmatched queries do not jump', () =>
    {
        const jumps: PaSection[] = []
        const tb = Fixtures.Make(jumps, [])
        tb.SetSearch('')
        tb.Jump()
        tb.SetSearch('zzzz')
        tb.Jump()
        assert.equal(jumps.length, 0)
        assert.equal(TopBar.MatchSection('zzzz'), undefined)
    })

    it('ToggleTheme flips scheme both ways', () =>
    {
        const tb = Fixtures.Make([], [])
        assert.equal(tb.CurrentScheme, ThemeScheme.Light)
        tb.ToggleTheme()
        assert.equal(tb.CurrentScheme, ThemeScheme.Dark)
        assert.equal(ThemeManager.ActiveScheme, PragmaticDark.instance)
        tb.ToggleTheme()
        assert.equal(tb.CurrentScheme, ThemeScheme.Light)
        assert.equal(ThemeManager.ActiveScheme, PragmaticLight.instance)
    })

    it('a plain Return bubbling to the bar jumps; a handled or non-Return event does not', () =>
    {
        const jumps: PaSection[] = []
        const tb = Fixtures.Make(jumps, [])
        tb.SetSearch('policy')
        Fixtures.Enter(tb)
        assert.deepEqual(jumps, [PaSection.ReleasePolicy])
        // Already handled (e.g. consumed by a focused button) -> no jump.
        Fixtures.Enter(tb, Key.Return, true)
        // A non-Return key -> no jump.
        Fixtures.Enter(tb, Key.Space, false)
        assert.equal(jumps.length, 1)
    })

    it('Logout, Legacy, OperatorEmail and Context', () =>
    {
        const logouts: number[] = []
        const legacies: number[] = []
        const tb = Fixtures.Make([], logouts, legacies)
        tb.Logout()
        tb.Legacy()
        assert.equal(logouts.length, 1)
        assert.equal(legacies.length, 1)
        assert.equal(tb.OperatorEmail, 'op@example.com')
        assert.equal(tb.Context, 'Platform')
        assert.equal(tb.BannerSlot.Children.Count, 0)
    })
})
