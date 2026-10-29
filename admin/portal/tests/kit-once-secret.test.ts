import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { OnceSecret } from '../src/kit/index.js'

describe('OnceSecret', () =>
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

    it('shows its value and is unconfirmed initially', () =>
    {
        const secret = new OnceSecret({ label: 'Owner password', value: 'hunter2', confirmLabel: 'I saved this', onConfirm: () => {} })
        assert.equal(secret.Confirmed, false)
        assert.equal(secret.Value, 'hunter2')
    })

    it('activating the confirm control calls onConfirm once and sets Confirmed', () =>
    {
        let count = 0
        const secret = new OnceSecret({ label: 'Agent token', value: 'tok-1', confirmLabel: 'I saved this', onConfirm: () => { count++ } })
        secret.ConfirmButton.Press()
        assert.equal(count, 1)
        assert.equal(secret.Confirmed, true)
        secret.ConfirmButton.Press()
        assert.equal(count, 1)
    })
})
