import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Key, Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import {
    Act, ErrorStatePanel, KeyActivatedButton, ScreenHost, ScreenHostInputs, ScreenState,
} from '../src/kit/index.js'

class Fixtures
{
    public static Inputs(over: Partial<ScreenHostInputs>): ScreenHostInputs
    {
        return { loading: false, allowed: true, isEmpty: false, error: false, ...over }
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
})
