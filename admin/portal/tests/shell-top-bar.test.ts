import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Application, ThemeManager } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticDark, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { PaSection } from '../src/nav-model.js'
import { TopBar } from '../src/top-bar.js'

class Fixtures
{
    public static Make(jumps: PaSection[], logouts: number[]): TopBar
    {
        return new TopBar({
            context: 'Platform',
            operatorEmail: 'op@example.com',
            onJump: s => { jumps.push(s) },
            onLogout: () => { logouts.push(1) },
        })
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
        assert.equal(tb.CurrentScheme, 'light')
        tb.ToggleTheme()
        assert.equal(tb.CurrentScheme, 'dark')
        assert.equal(ThemeManager.ActiveScheme, PragmaticDark.instance)
        tb.ToggleTheme()
        assert.equal(tb.CurrentScheme, 'light')
        assert.equal(ThemeManager.ActiveScheme, PragmaticLight.instance)
    })

    it('Logout, OperatorEmail and Context', () =>
    {
        const logouts: number[] = []
        const tb = Fixtures.Make([], logouts)
        tb.Logout()
        assert.equal(logouts.length, 1)
        assert.equal(tb.OperatorEmail, 'op@example.com')
        assert.equal(tb.Context, 'Platform')
        assert.equal(tb.BannerSlot.Children.Count, 0)
    })
})
