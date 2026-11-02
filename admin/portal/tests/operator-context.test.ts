import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OperatorContext, OperatorRole } from '../src/operator-context.js'

describe('OperatorContext', () =>
{
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

    it('the denied hint names the Operator role and whom to ask', () =>
    {
        const ctx = OperatorContext.FromWire('readonly')
        assert.equal(ctx.NeededRoleLabel, 'Operator')
        assert.equal(ctx.AskWhom, 'your operator lead')
    })
})
