import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { Steps } from '../../src/kit/index.js'

class Fixtures
{
    public static readonly Labels = ['One', 'Two', 'Three']
}

describe('Steps', () =>
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

    it('starts on the first step; Advance and Back move and clamp', () =>
    {
        const steps = new Steps({ labels: Fixtures.Labels })
        assert.equal(steps.ActiveIndex, 0)
        steps.Back()
        assert.equal(steps.ActiveIndex, 0)
        steps.Advance()
        assert.equal(steps.ActiveIndex, 1)
        steps.Back()
        assert.equal(steps.ActiveIndex, 0)
        steps.Advance()
        steps.Advance()
        steps.Advance()
        assert.equal(steps.ActiveIndex, 2)
    })

    it('Select marks exactly the chosen step active', () =>
    {
        const steps = new Steps({ labels: Fixtures.Labels })
        assert.equal(steps.IsActiveStep(0), true)
        steps.Select(2)
        assert.equal(steps.ActiveIndex, 2)
        assert.equal(steps.IsActiveStep(2), true)
        assert.equal(steps.IsActiveStep(0), false)
        assert.equal(steps.IsActiveStep(1), false)
    })

    it('Select on the current index is a no-op', () =>
    {
        const steps = new Steps({ labels: Fixtures.Labels })
        const before = [...steps.Children].length
        steps.Select(0)
        assert.equal([...steps.Children].length, before)
    })

    it('ignores out-of-range indices', () =>
    {
        const steps = new Steps({ labels: Fixtures.Labels })
        steps.Select(7)
        steps.Select(-1)
        assert.equal(steps.ActiveIndex, 0)
    })

    it('onChange fires on real changes only', () =>
    {
        const seen: number[] = []
        const steps = new Steps({ labels: Fixtures.Labels, onChange: i => seen.push(i) })
        steps.Select(0)
        steps.Back()
        assert.deepEqual(seen, [])
        steps.Select(2)
        steps.Back()
        steps.Advance()
        steps.Advance()
        assert.deepEqual(seen, [2, 1, 2])
    })
})
