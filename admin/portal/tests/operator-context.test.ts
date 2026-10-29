import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { Act, ActVariant } from '../src/kit/act.js'
import { OperatorContext, OperatorRole } from '../src/operator-context.js'

describe('OperatorContext', () =>
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

    it('RoleLabel maps wire roles to labels', () =>
    {
        assert.equal(OperatorContext.RoleLabel('full'), 'Operator')
        assert.equal(OperatorContext.RoleLabel('readonly'), 'Observer')
        assert.equal(OperatorContext.RoleLabel('anything'), 'Observer')
    })

    it('full maps to Operator and may mutate', () =>
    {
        const ctx = OperatorContext.FromWire('full')
        assert.equal(ctx.CanMutate, true)
        assert.equal(ctx.RoleLabel, 'Operator')
    })

    it('readonly maps to Observer and may not mutate', () =>
    {
        const ctx = OperatorContext.FromWire('readonly')
        assert.equal(ctx.CanMutate, false)
        assert.equal(ctx.RoleLabel, 'Observer')
    })

    it('unknown or empty wire role is Observer (deny-by-default)', () =>
    {
        assert.equal(OperatorContext.FromWire('bogus').Role, OperatorRole.Observer)
        assert.equal(OperatorContext.FromWire('').Role, OperatorRole.Observer)
    })

    it('Operator MutatingAct is enabled and press fires onClick once', () =>
    {
        let count = 0
        const act = new Act(OperatorContext.FromWire('full').MutatingAct('Delete', () => { count++ }, ActVariant.Danger))
        assert.equal(act.Enabled, true)
        act.Press()
        assert.equal(count, 1)
    })

    it('Observer MutatingAct is disabled, names the Operator role, and does not fire', () =>
    {
        let count = 0
        const act = new Act(OperatorContext.FromWire('readonly').MutatingAct('Delete', () => { count++ }, ActVariant.Danger))
        assert.equal(act.Enabled, false)
        assert.ok(act.DisabledHint !== undefined && act.DisabledHint.includes('Operator'))
        act.Press()
        assert.equal(count, 0)
    })
})
