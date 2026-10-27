import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { Act } from '../../src/kit/act.js'

describe('Act', () =>
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

    it('is enabled and fires onClick when permitted', () =>
    {
        let clicks = 0
        const act = new Act({ can: true, label: 'Go', onClick: () => { clicks++ } })
        assert.equal(act.Enabled, true)
        assert.equal(act.DisabledHint, undefined)
        act.Press()
        assert.equal(clicks, 1)
    })

    it('is visible but disabled with the need hint when denied, and never fires', () =>
    {
        let clicks = 0
        const act = new Act({ can: false, need: 'tenant-admin', label: 'Go', onClick: () => { clicks++ } })
        assert.equal(act.Enabled, false)
        assert.notEqual(act.Content, undefined)
        assert.ok(act.DisabledHint?.includes('tenant-admin'))
        act.Press()
        assert.equal(clicks, 0)
    })

    it('exposes disabledReason when denied without a need', () =>
    {
        const act = new Act({ can: false, disabledReason: 'Read only', label: 'Go', onClick: () => undefined })
        assert.equal(act.DisabledHint, 'Read only')
    })
})
