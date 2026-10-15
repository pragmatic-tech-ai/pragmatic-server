import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Principal, PrincipalKind, PrivilegeAction, AccessLevel, OwnershipSourceKind } from '@pragmatic-tech-ai/todl-identity'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import type { IInstanceView, IInstanceFilter } from '@pragmatic-tech-ai/todl'
import { AccessDepthEvaluator } from '@pragmatic-tech-ai/todl-identity-engine'
import { AccessDepthWriteInstanceGate, AllowAllWriteInstanceGate } from '../write-instance-gate.js'
import type { IWriteInstanceGate } from '../write-instance-gate.js'
import type { IWriteTargetSource } from '../../write-target-source.js'

const Widget = 'shop.Widget'

class Fx
{
    // Principal u1 lives in BU "sales"; may Update shop.Widget at BusinessUnit level; ownership from field "owningBu".
    public static Config(): ISecurityModelConfig
    {
        return {
            businessUnits: [{ id: 'root', name: 'Root' }, { id: 'sales', name: 'Sales', parent: 'root' }],
            teams: [],
            membership: { claimsMapping: [], overrides: [{ principalId: 'u1', homeBusinessUnit: 'sales', teams: [] }] },
            ownershipRules: [{ concept: Widget, owningBusinessUnit: { kind: OwnershipSourceKind.FromField, value: 'owningBu' } }],
            roles: [{ id: 'w', name: 'Writer', privileges: [{ action: PrivilegeAction.Update, concept: Widget, level: AccessLevel.BusinessUnit }] }],
            roleAssignment: { claimsMapping: [], overrides: [{ principalId: 'u1', roles: ['w'] }], teamRoles: [] },
        } as ISecurityModelConfig
    }

    public static Principal(): Principal
    {
        return new Principal('u1', 't1', PrincipalKind.User, new Map(), [])
    }

    public static View(owningBu: string): IInstanceView
    {
        return { Concept: Widget, Field: (n: string) => (n === 'owningBu' ? owningBu : undefined) }
    }

    public static Target(views: Record<string, IInstanceView | undefined>): IWriteTargetSource
    {
        return { Fetch: async (_c: string, id: string) => views[id] }
    }

    public static KeepAll(): IInstanceFilter
    {
        return { Keep: () => true }
    }

    public static DenyAll(): IInstanceFilter
    {
        return { Keep: () => false }
    }
}

test('Authorize passes own-BU row and denies out-of-BU row (write depth)', () =>
{
    const e = AccessDepthEvaluator.FromConfig(Fx.Config())
    const gate = new AccessDepthWriteInstanceGate(e, Fx.Principal(), Fx.KeepAll(), Fx.Target({}))
    assert.equal(gate.Authorize(PrivilegeAction.Update, Fx.View('sales')), true)
    assert.equal(gate.Authorize(PrivilegeAction.Update, Fx.View('root')), false)
})

test('Authorize is deny-wins with the predicate', () =>
{
    const e = AccessDepthEvaluator.FromConfig(Fx.Config())
    const gate = new AccessDepthWriteInstanceGate(e, Fx.Principal(), Fx.DenyAll(), Fx.Target({}))
    assert.equal(gate.Authorize(PrivilegeAction.Update, Fx.View('sales')), false)
})

test('AuthorizeById denies when the row is not fetchable, allows an in-scope row', async () =>
{
    const e = AccessDepthEvaluator.FromConfig(Fx.Config())
    const target = Fx.Target({ ok: Fx.View('sales'), out: Fx.View('root') })
    const gate = new AccessDepthWriteInstanceGate(e, Fx.Principal(), Fx.KeepAll(), target)
    assert.equal(await gate.AuthorizeById(PrivilegeAction.Update, Widget, 'ok'), true)
    assert.equal(await gate.AuthorizeById(PrivilegeAction.Update, Widget, 'out'), false)
    assert.equal(await gate.AuthorizeById(PrivilegeAction.Update, Widget, 'missing'), false)
})

test('CreateDefaults forwards the evaluator stamp', () =>
{
    const e = AccessDepthEvaluator.FromConfig(Fx.Config())
    const gate = new AccessDepthWriteInstanceGate(e, Fx.Principal(), Fx.KeepAll(), Fx.Target({}))
    assert.deepEqual(gate.CreateDefaults(Widget), [{ field: 'owningBu', value: 'sales' }])
})

test('AllowAll gate allows everything with no stamping', async () =>
{
    const gate: IWriteInstanceGate = AllowAllWriteInstanceGate.Instance
    assert.deepEqual(gate.CreateDefaults(Widget), [])
    assert.equal(gate.Authorize(PrivilegeAction.Update, Fx.View('sales')), true)
    assert.equal(await gate.AuthorizeById(PrivilegeAction.Update, Widget, 'anything'), true)
    assert.equal(await gate.Resolve('x', 'y'), undefined)
})
