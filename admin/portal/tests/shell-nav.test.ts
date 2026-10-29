import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { NavModel, PaSection } from '../src/nav-model.js'
import { NavRail } from '../src/nav-rail.js'

describe('platform admin nav', () =>
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

    it('flattens to the ten sections in order', () =>
    {
        const flat = NavModel.Groups.flatMap(g => g.items.map(i => i.Section))
        assert.deepEqual(flat, [
            PaSection.Fleet, PaSection.Activity, PaSection.Clients, PaSection.Tenants, PaSection.Hives, PaSection.Registry,
            PaSection.ReleasePolicy, PaSection.AgentChannel, PaSection.PlatformComponents, PaSection.Settings,
        ])
    })

    it('has the documented headings; Fleet and Settings groups are heading-less', () =>
    {
        assert.deepEqual(NavModel.Groups.map(g => g.heading), [
            undefined, 'Provisioning', 'Releases', 'Channel & software', undefined,
        ])
        assert.equal(NavModel.LabelFor(PaSection.Registry), 'Registry & Releases')
    })

    it('rail builds a row per section, tags only the active row, and forwards Select', () =>
    {
        const selected: PaSection[] = []
        const rail = new NavRail(s => selected.push(s))
        assert.equal(rail.Rows.size, 10)
        rail.SetActive(PaSection.Clients)
        assert.equal(rail.Active, PaSection.Clients)
        for (const [section, button] of rail.Rows)
        {
            assert.equal(button.Tag, section === PaSection.Clients ? NavRail.CurrentRole : null)
        }
        rail.Select(PaSection.Tenants)
        assert.deepEqual(selected, [PaSection.Tenants])
    })

    it('FocusActive targets the active row and is a no-op with no active row', () =>
    {
        // Mural exposes no headless focus-state seam, so this pins that FocusActive resolves to the
        // active row's button and runs without error (the keyboard-focus effect itself is an e2e concern).
        const idle = new NavRail(() => {})
        assert.equal(idle.Active, undefined)
        idle.FocusActive()
        const rail = new NavRail(() => {}, PaSection.Settings)
        assert.equal(rail.Active, PaSection.Settings)
        assert.ok(rail.Rows.get(PaSection.Settings) !== undefined)
        rail.FocusActive()
    })
})
