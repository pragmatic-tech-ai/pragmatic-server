import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { Key, Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import {
    Act, ErrorStatePanel, InternalTag, KeyActivatedButton, ObservedPanel, PageHeader, PillKind, ScreenHost, ScreenHostInputs, ScreenState,
    StatusPill,
} from '../src/kit/index.js'

class Fixtures
{
    public static Inputs(over: Partial<ScreenHostInputs>): ScreenHostInputs
    {
        return { loading: false, allowed: true, isEmpty: false, error: false, ...over }
    }

    public static Descendants(v: unknown): unknown[]
    {
        const out: unknown[] = []
        for (const c of [...((v as { Children?: readonly unknown[] }).Children ?? [])])
        {
            out.push(c, ...Fixtures.Descendants(c))
        }
        return out
    }

    public static Click(b: KeyActivatedButton): void
    {
        for (const h of (b as unknown as { _clickHandlers: Array<(a: unknown) => void> })._clickHandlers)
        {
            h({})
        }
    }

    public static Press(b: KeyActivatedButton, key: Key): void
    {
        (b as unknown as { OnKeyDown(a: unknown): void }).OnKeyDown({ Key: key, Handled: false })
    }
}

describe('kit screen states', () =>
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

    it('ScreenHost.Resolve honors precedence loading > denied > error > empty > populated', () =>
    {
        assert.equal(ScreenHost.Resolve(Fixtures.Inputs({ loading: true })), ScreenState.Loading)
        assert.equal(ScreenHost.Resolve(Fixtures.Inputs({ loading: true, error: true })), ScreenState.Loading)
        assert.equal(ScreenHost.Resolve(Fixtures.Inputs({ allowed: false, error: true })), ScreenState.Denied)
        assert.equal(ScreenHost.Resolve(Fixtures.Inputs({ error: true })), ScreenState.Error)
        assert.equal(ScreenHost.Resolve(Fixtures.Inputs({ isEmpty: true })), ScreenState.Empty)
        assert.equal(ScreenHost.Resolve(Fixtures.Inputs({})), ScreenState.Populated)
    })

    it('Error panel Retry is a keyboard-reachable KeyActivatedButton that invokes onRetry', () =>
    {
        let count = 0
        const panel = new ErrorStatePanel({ title: 'T', onRetry: () => { count++ } })
        assert.ok(panel.RetryButton instanceof KeyActivatedButton)
        assert.equal(panel.RetryButton.Focusable, true)
        Fixtures.Click(panel.RetryButton)
        assert.equal(count, 1)
        Fixtures.Press(panel.RetryButton, Key.Return)
        assert.equal(count, 2)
    })

    it('Act denied is visible-but-disabled, carries the need hint and does not fire', () =>
    {
        let count = 0
        const act = new Act({ can: false, need: 'Owner', label: 'Go', onClick: () => { count++ } })
        assert.equal(act.Enabled, false)
        assert.ok((act.DisabledHint ?? '').includes('Owner'))
        act.Press()
        assert.equal(count, 0)
    })

    it('Act allowed fires exactly once per Press and per Enter', () =>
    {
        let count = 0
        const act = new Act({ can: true, label: 'Go', onClick: () => { count++ } })
        act.Press()
        assert.equal(count, 1)
        Fixtures.Press(act, Key.Return)
        assert.equal(count, 2)
        Fixtures.Click(act)
        assert.equal(count, 3)
    })

    it('PageHeader renders breadcrumb, title and no tabs by default', () =>
    {
        const h = new PageHeader({ breadcrumb: ['Platform', 'Fleet'], title: 'Fleet' })
        assert.equal(h.BreadcrumbText, 'Platform / Fleet')
        assert.equal(h.Title, 'Fleet')
        assert.equal(h.TabControls.length, 0)
    })

    it('PageHeader tabs are KeyActivatedButtons and SetActiveTab marks only the chosen one', () =>
    {
        let picked = 0
        const h = new PageHeader({
            breadcrumb: ['Platform'],
            title: 'Hives',
            tabs: [{ label: 'A', onSelect: () => { picked = 1 } }, { label: 'B', onSelect: () => { picked = 2 } }],
        })
        assert.equal(h.TabControls.length, 2)
        assert.ok(h.TabControls[0] instanceof KeyActivatedButton)
        h.SetActiveTab(1)
        assert.notEqual(h.TabControls[0].Tag, 'current')
        assert.equal(h.TabControls[1].Tag, 'current')
        Fixtures.Press(h.TabControls[1], Key.Return)
        assert.equal(picked, 2)
    })

    it('PageHeader includes a provided primaryAction as a child', () =>
    {
        const act = new Act({ can: true, label: 'New', onClick: () => { } })
        const h = new PageHeader({ breadcrumb: ['Platform'], title: 'Clients', primaryAction: act })
        const found = (function Walk(v: { Children?: readonly unknown[] }): boolean
        {
            return [...(v.Children ?? [])].some(c => c === act || Walk(c as { Children?: readonly unknown[] }))
        })(h as unknown as { Children?: readonly unknown[] })
        assert.ok(found)
    })

    it('InternalTag label is Internal', () =>
    {
        assert.equal(new InternalTag().Label, 'Internal')
    })

    it('ObservedPanel shows title, Observed pill, default or given note', () =>
    {
        const body = new TextBlock()
        body.Text = 'x'
        const p = new ObservedPanel({ title: 'Cluster', body })
        assert.equal(p.Title, 'Cluster')
        assert.ok(p.NoteText.length > 0)
        assert.equal(new ObservedPanel({ title: 'T', note: 'custom', body: new TextBlock() }).NoteText, 'custom')
        const pills = Fixtures.Descendants(p).filter(d => d instanceof StatusPill) as StatusPill[]
        assert.ok(pills.some(d => d.Kind === PillKind.Observed))
    })

    it('ObservedPanel contains no interactive control', () =>
    {
        const body = new TextBlock()
        body.Text = 'x'
        const all = Fixtures.Descendants(new ObservedPanel({ title: 'T', body }))
        assert.ok(!all.some(d => d instanceof KeyActivatedButton || d instanceof Button))
    })
})
