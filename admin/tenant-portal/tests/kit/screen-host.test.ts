import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Rectangle, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { KitGlyph } from '../../src/kit/icon-catalog.js'
import { ScreenHost, ScreenHostInputs, ScreenState } from '../../src/kit/screen-host.js'
import { DeniedStatePanel, EmptyStatePanel, ErrorStatePanel, SkeletonKind, SkeletonPanel } from '../../src/kit/state-panels.js'

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

    public static Texts(node: unknown): string[]
    {
        return Walk.Collect(node).filter(n => n instanceof TextBlock).map(n => (n as TextBlock).Text)
    }
}

class Marker extends Rectangle
{
}

class Fixture
{

    public static Inputs(over: Partial<ScreenHostInputs>): ScreenHostInputs
    {
        return {
            loading: false, allowed: true, isEmpty: false, error: false,
            empty: { glyph: KitGlyph.Users, title: 'No users', body: 'Invite someone.' },
            content: () => new Marker(),
            ...over,
        }
    }
}

describe('ScreenHost', () =>
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

    it('Loading renders skeleton', () =>
    {
        const host = new ScreenHost(Fixture.Inputs({ loading: true }))
        assert.equal(host.State, ScreenState.Loading)
        const nodes = Walk.Collect(host)
        assert.ok(nodes.some(n => n instanceof SkeletonPanel))
        assert.ok(!nodes.some(n => n instanceof Marker))
    })

    it('Denied renders denied panel', () =>
    {
        const host = new ScreenHost(Fixture.Inputs({ allowed: false }))
        assert.equal(host.State, ScreenState.Denied)
        assert.ok(Walk.Collect(host).some(n => n instanceof DeniedStatePanel))
    })

    it('Error renders error panel', () =>
    {
        const host = new ScreenHost(Fixture.Inputs({ error: true }))
        assert.equal(host.State, ScreenState.Error)
        assert.ok(Walk.Collect(host).some(n => n instanceof ErrorStatePanel))
    })

    it('Empty renders empty panel with supplied copy', () =>
    {
        const host = new ScreenHost(Fixture.Inputs({ isEmpty: true }))
        assert.equal(host.State, ScreenState.Empty)
        assert.ok(Walk.Collect(host).some(n => n instanceof EmptyStatePanel))
        assert.deepEqual(Walk.Texts(host), ['No users', 'Invite someone.'])
    })

    it('Populated renders content only', () =>
    {
        const host = new ScreenHost(Fixture.Inputs({}))
        assert.equal(host.State, ScreenState.Populated)
        const nodes = Walk.Collect(host)
        assert.ok(nodes.some(n => n instanceof Marker))
        assert.ok(!nodes.some(n => n instanceof SkeletonPanel || n instanceof DeniedStatePanel
            || n instanceof ErrorStatePanel || n instanceof EmptyStatePanel))
    })

    it('content builder is invoked when populated', () =>
    {
        const host = new ScreenHost(Fixture.Inputs({ content: () => new Marker() }))
        assert.ok(Walk.Collect(host).some(n => n instanceof Marker))
    })

    it('precedence: loading beats error', () =>
    {
        assert.equal(new ScreenHost(Fixture.Inputs({ loading: true, error: true })).State, ScreenState.Loading)
    })

    it('precedence: denied beats error', () =>
    {
        assert.equal(new ScreenHost(Fixture.Inputs({ allowed: false, error: true })).State, ScreenState.Denied)
    })

    it('precedence: error beats empty', () =>
    {
        assert.equal(new ScreenHost(Fixture.Inputs({ error: true, isEmpty: true })).State, ScreenState.Error)
    })

    it('precedence: loading beats denied', () =>
    {
        assert.equal(new ScreenHost(Fixture.Inputs({ loading: true, allowed: false })).State, ScreenState.Loading)
    })

    it('Update re-resolves and swaps the panel', () =>
    {
        const host = new ScreenHost(Fixture.Inputs({ loading: true }))
        host.Update(Fixture.Inputs({}))
        assert.equal(host.State, ScreenState.Populated)
        assert.ok(!Walk.Collect(host).some(n => n instanceof SkeletonPanel))
    })

    it('Denied panel shows default design copy', () =>
    {
        const texts = Walk.Texts(new DeniedStatePanel())
        assert.deepEqual(texts, [
            "You don't have access to this page",
            'This needs a higher role. Ask an administrator to grant it. Nothing here was changed.',
        ])
    })

    it('Denied panel interpolates what/need/who', () =>
    {
        const panel = new DeniedStatePanel({ what: 'Billing', need: 'Owner', who: 'the tenant owner' })
        assert.equal(panel.Heading, "You don't have access to Billing")
        assert.equal(panel.BodyText, 'This needs Owner. Ask the tenant owner to grant it. Nothing here was changed.')
    })

    it('Error panel shows default copy, retry button and alert role', () =>
    {
        const panel = new ErrorStatePanel()
        const texts = Walk.Texts(panel)
        assert.ok(texts.includes(ErrorStatePanel.DefaultTitle))
        assert.ok(texts.includes(ErrorStatePanel.DefaultBody))
        assert.ok(texts.includes(ErrorStatePanel.DefaultCode))
        assert.equal(ErrorStatePanel.DefaultTitle, "Couldn't load this page.")
        assert.equal(ErrorStatePanel.DefaultCode, 'Ref 7F3A-21C')
        assert.equal(ErrorStatePanel.RetryLabel, 'Try again')
        assert.ok(Walk.Collect(panel).includes(panel.RetryButton))
        assert.equal(panel.Role, 'alert')
        assert.equal(panel.Tag, 'alert')
    })

    it('Error panel honours overrides', () =>
    {
        const texts = Walk.Texts(new ErrorStatePanel({ title: 'T', body: 'B', code: 'C' }))
        assert.deepEqual(texts.slice(0, 3), ['T', 'B', 'C'])
    })

    for (const kind of [SkeletonKind.Table, SkeletonKind.Detail, SkeletonKind.Cards, SkeletonKind.Form])
    {
        it(`SkeletonKind ${SkeletonKind[kind]} renders placeholders`, () =>
        {
            const panel = new SkeletonPanel(kind)
            assert.equal(panel.Kind, kind)
            assert.equal(panel.Tag, SkeletonPanel.BusyRole)
            assert.ok(Walk.Collect(panel).some(n => n instanceof Rectangle))
        })
    }
})
