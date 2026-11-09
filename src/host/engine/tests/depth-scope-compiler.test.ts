import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessDefault, FalsePredicate } from '@pragmatic-tech-ai/graph'
import type { CellValue } from '@pragmatic-tech-ai/graph'
import { AccessLevel, PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import type { IFieldSecurityConfig, IPrivilegeConfig } from '@pragmatic-tech-ai/todl-identity'
import { DepthDiagnosticCode, DepthScopeCompiler } from '../depth-scope-compiler.js'
import type { DepthScope } from '../depth-scope-compiler.js'
import { DevScopeFx, ScopeAxis } from './dev-scope-fixture.js'

/** Widget instances spanning every ownership case the evaluator distinguishes. */
class Instances
{
    public static readonly All: Readonly<Record<string, Readonly<Record<string, CellValue>>>> = {
        mine: { owner: DevScopeFx.P1, owningBu: DevScopeFx.Sales },
        team: { owner: DevScopeFx.TeamA, owningBu: DevScopeFx.North },
        east: { owner: DevScopeFx.P2, owningBu: DevScopeFx.East },
        deep: { owner: DevScopeFx.P2, owningBu: DevScopeFx.East1 },
        north: { owner: DevScopeFx.P2, owningBu: DevScopeFx.North },
        rooted: { owner: DevScopeFx.P2, owningBu: DevScopeFx.Root },
        unset: { owner: DevScopeFx.P2 },
        empty: { owner: '', owningBu: '' },
        bogus: { owner: DevScopeFx.P2, owningBu: 'nowhere' },
        ownerless: { owningBu: DevScopeFx.Sales },
    }
}

class DepthFx
{
    public static readonly Levels: readonly AccessLevel[] = [AccessLevel.None, AccessLevel.User, AccessLevel.BusinessUnit, AccessLevel.BusinessUnitAndChildren, AccessLevel.Organization]
    public static readonly Actions: readonly (readonly [PrivilegeAction, ScopeAxis])[] = [
        [PrivilegeAction.Read, ScopeAxis.Read],
        [PrivilegeAction.Create, ScopeAxis.Create],
        [PrivilegeAction.Update, ScopeAxis.Update],
        [PrivilegeAction.Delete, ScopeAxis.Delete],
    ]

    public static async Compile(privileges: readonly IPrivilegeConfig[], principal: string = DevScopeFx.P1, fields?: IFieldSecurityConfig): Promise<{ Depth: DepthScope; Visible: (axis: ScopeAxis, concept?: string) => string[]; Expected: (action: PrivilegeAction, concept?: string) => string[] }>
    {
        const { Auth } = await DevScopeFx.Authorization(DevScopeFx.Model(privileges, fields))
        const context = DevScopeFx.Context(principal)
        const security = await Auth.SecurityFor(context)
        const depth = DepthScopeCompiler.Compile(security, context.Principal, DevScopeFx.Description())
        const names = Object.keys(Instances.All)
        return {
            Depth: depth,
            Visible: (axis, concept = DevScopeFx.Widget) => names.filter(name => DevScopeFx.Admits(depth.Scope(), concept, axis, Instances.All[name]!)),
            // today's per-instance decision (AccessDepthInstanceFilter / AccessDepthWriteInstanceGate)
            Expected: (action, concept = DevScopeFx.Widget) => names.filter(name => security.Evaluator.Allows(context.Principal, action, { Concept: concept, Field: field => Instances.All[name]![field] as string | undefined })),
        }
    }
}

describe('DepthScopeCompiler: one access level per action, as today\'s evaluator decides it', () =>
{
    const expected: Readonly<Record<AccessLevel, readonly string[]>> = {
        [AccessLevel.None]: [],
        [AccessLevel.User]: ['mine', 'team'],
        [AccessLevel.BusinessUnit]: ['mine', 'team', 'north', 'ownerless'],
        [AccessLevel.BusinessUnitAndChildren]: ['mine', 'team', 'east', 'deep', 'north', 'ownerless'],
        [AccessLevel.Organization]: Object.keys(Instances.All),
    }
    for (const level of DepthFx.Levels)
    {
        for (const [action, axis] of DepthFx.Actions)
        {
            test(`${level} ${action}`, async () =>
            {
                const fx = await DepthFx.Compile([DevScopeFx.Privilege(action, level)])
                assert.deepEqual(fx.Visible(axis), expected[level])
                assert.deepEqual(fx.Visible(axis), fx.Expected(action), 'parity with AccessDepthEvaluator.Allows')
                for (const [, other] of DepthFx.Actions.filter(([a]) => a !== action))
                {
                    assert.deepEqual(fx.Visible(other), [], 'a privilege grants only its own action')
                }
            })
        }
    }
})

describe('DepthScopeCompiler ownership semantics', () =>
{
    test('teams count for user level', async () =>
    {
        const withTeam = await DepthFx.Compile([DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.User)])
        assert.ok(withTeam.Visible(ScopeAxis.Read).includes('team'), 'a record owned by the principal\'s team is visible')
        // p2 holds the same role through an override of its own: no team, so only its own records
        const model = DevScopeFx.Model([DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.User)])
        const { Auth } = await DevScopeFx.Authorization({ ...model, roleAssignment: { claimsMapping: [], teamRoles: [], overrides: [{ principalId: DevScopeFx.P2, roles: [DevScopeFx.Role] }] } })
        const context = DevScopeFx.Context(DevScopeFx.P2)
        const depth = DepthScopeCompiler.Compile(await Auth.SecurityFor(context), context.Principal, DevScopeFx.Description())
        const visible = Object.keys(Instances.All).filter(name => DevScopeFx.Admits(depth.Scope(), DevScopeFx.Widget, ScopeAxis.Read, Instances.All[name]!))
        assert.deepEqual(visible, ['east', 'deep', 'north', 'rooted', 'unset', 'bogus'])
    })

    test('parent-child reach includes descendants', async () =>
    {
        const fx = await DepthFx.Compile([DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.BusinessUnitAndChildren)])
        const visible = fx.Visible(ScopeAxis.Read)
        assert.ok(visible.includes('east') && visible.includes('deep'), 'child and grandchild units of the home unit')
        assert.ok(visible.includes('north'), 'the team\'s unit is in reach')
        assert.ok(!visible.includes('rooted'), 'the parent of the home unit is not')
    })

    test('an unset, empty or unknown business unit reads as the root unit (OwnershipResolver)', async () =>
    {
        // p2 lives in sales; give it a root home through a team owned by root to put the root in reach
        const base = DevScopeFx.Model([DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.BusinessUnit)])
        const model = { ...base, teams: [...base.teams, { id: 'team-root', name: 'R', owningBusinessUnit: DevScopeFx.Root }],
            membership: { claimsMapping: [], overrides: [{ principalId: DevScopeFx.P1, homeBusinessUnit: DevScopeFx.Sales, teams: ['team-root'] }] } }
        const { Auth } = await DevScopeFx.Authorization(model)
        const context = DevScopeFx.Context(DevScopeFx.P1)
        const security = await Auth.SecurityFor(context)
        const depth = DepthScopeCompiler.Compile(security, context.Principal, DevScopeFx.Description())
        const names = Object.keys(Instances.All)
        const visible = names.filter(name => DevScopeFx.Admits(depth.Scope(), DevScopeFx.Widget, ScopeAxis.Read, Instances.All[name]!))
        assert.deepEqual(visible, ['mine', 'rooted', 'unset', 'empty', 'bogus', 'ownerless'])
        assert.deepEqual(visible, names.filter(name => security.Evaluator.Allows(context.Principal, PrivilegeAction.Read, { Concept: DevScopeFx.Widget, Field: field => Instances.All[name]![field] as string | undefined })))
    })

    test('a fixed owning unit is a constant', async () =>
    {
        const inReach = await DepthFx.Compile([DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.BusinessUnit, DevScopeFx.Gadget)])
        assert.deepEqual(inReach.Visible(ScopeAxis.Read, DevScopeFx.Gadget), Object.keys(Instances.All), 'north is in p1\'s reach through team-a')
        assert.deepEqual(inReach.Visible(ScopeAxis.Read, DevScopeFx.Gadget), inReach.Expected(PrivilegeAction.Read, DevScopeFx.Gadget))
        const user = await DepthFx.Compile([DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.User, DevScopeFx.Gadget)])
        assert.equal(user.Depth.Rows.get(DevScopeFx.Gadget), undefined, 'Gadget has no owner: User level denies (left to the Default Deny)')
        assert.ok(user.Depth.Diagnostics.some(d => d.Code === DepthDiagnosticCode.NoOwner && d.Concept === DevScopeFx.Gadget))
    })

    test('a missing ownership field compiles to False with a diagnostic', async () =>
    {
        const base = DevScopeFx.Model([DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.User)])
        const model = { ...base, ownershipRules: [{ ...base.ownershipRules[0]!, owner: { kind: base.ownershipRules[0]!.owner!.kind, value: 'nope' } }] }
        const { Auth } = await DevScopeFx.Authorization(model)
        const context = DevScopeFx.Context(DevScopeFx.P1)
        const depth = DepthScopeCompiler.Compile(await Auth.SecurityFor(context), context.Principal, DevScopeFx.Description())
        assert.equal(depth.Rows.get(DevScopeFx.Widget), undefined)
        assert.equal(DevScopeFx.Admits(depth.Scope(), DevScopeFx.Widget, ScopeAxis.Read, Instances.All['mine']!), false)
        assert.ok(depth.Diagnostics.some(d => d.Code === DepthDiagnosticCode.MissingOwnerField && d.Concept === DevScopeFx.Widget))
    })
})

describe('DepthScopeCompiler ungoverned concepts and inheritance (AccessDepthInstanceFilter semantics)', () =>
{
    test('a concept without a privilege is denied: Default Deny, no entry', async () =>
    {
        const fx = await DepthFx.Compile([DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.Organization)])
        assert.equal(fx.Depth.Default, AccessDefault.Deny)
        assert.equal(fx.Depth.Rows.has(DevScopeFx.Gadget), false)
        assert.deepEqual(fx.Visible(ScopeAxis.Read, DevScopeFx.Gadget), [])
        assert.deepEqual(fx.Visible(ScopeAxis.Read, DevScopeFx.Gadget), fx.Expected(PrivilegeAction.Read, DevScopeFx.Gadget))
    })

    test('a subconcept the evaluator does not govern stays denied under a granted parent', async () =>
    {
        const fx = await DepthFx.Compile([DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.Organization)])
        assert.equal(fx.Depth.Rows.get(DevScopeFx.Gizmo), FalsePredicate.Instance, 'explicit False: the parent\'s True would admit it')
        assert.deepEqual(fx.Visible(ScopeAxis.Read, DevScopeFx.Gizmo), fx.Expected(PrivilegeAction.Read, DevScopeFx.Gizmo))
    })

    test('a governed subconcept under an ungoverned parent keeps its own level', async () =>
    {
        const fx = await DepthFx.Compile([DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.Organization, DevScopeFx.Gizmo)])
        assert.equal(fx.Depth.Rows.has(DevScopeFx.Widget), false, 'the ungoverned parent is left to the Default, not False')
        assert.deepEqual(fx.Visible(ScopeAxis.Read, DevScopeFx.Gizmo), Object.keys(Instances.All))
        assert.deepEqual(fx.Visible(ScopeAxis.Read, DevScopeFx.Widget), [])
    })

    test('a subconcept is never wider than a governed parent (the engine applies entries to descendants)', async () =>
    {
        const fx = await DepthFx.Compile([
            DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.User),
            DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.Organization, DevScopeFx.Gizmo),
        ])
        // today the Gizmo grant alone decides (all visible); on the engine the Widget entry also applies: fail-closed
        assert.deepEqual(fx.Visible(ScopeAxis.Read, DevScopeFx.Gizmo), ['mine', 'team'])
    })

    test('taxonomy terms stay readable but not writable', async () =>
    {
        const fx = await DepthFx.Compile([])
        assert.equal(DevScopeFx.Admits(fx.Depth.Scope(), DevScopeFx.Term, ScopeAxis.Read, {}), true)
        assert.equal(DevScopeFx.Admits(fx.Depth.Scope(), DevScopeFx.Term, ScopeAxis.Create, {}), false)
    })

    test('no security model is deny all', async () =>
    {
        const { Auth } = await DevScopeFx.Authorization()
        const context = DevScopeFx.Context(DevScopeFx.P1)
        const depth = DepthScopeCompiler.Compile(await Auth.SecurityFor(context), context.Principal, DevScopeFx.Description())
        assert.equal(depth.Rows.get(DevScopeFx.Element), FalsePredicate.Instance)
        for (const concept of [DevScopeFx.Widget, DevScopeFx.Gadget, DevScopeFx.Term])
        {
            for (const [, axis] of DepthFx.Actions) assert.equal(DevScopeFx.Admits(depth.Scope(), concept, axis, Instances.All['mine']!), false)
        }
    })
})

describe('DepthScopeCompiler field security and create defaults', () =>
{
    const read = [DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.Organization)]

    test('secured readable field hidden without profile', async () =>
    {
        const fx = await DepthFx.Compile(read, DevScopeFx.P1, DevScopeFx.Fields([DevScopeFx.Secret], []))
        assert.deepEqual([...fx.Depth.Hidden.get(DevScopeFx.Widget) ?? []], [DevScopeFx.Secret])
        assert.equal(fx.Depth.ReadOnly.get(DevScopeFx.Widget), undefined, 'hidden members are not also read-only')
        assert.equal(fx.Depth.Hidden.has(DevScopeFx.Gadget), false, 'only the secured concept')
    })

    test('readable but not writable field is read-only', async () =>
    {
        const fields = DevScopeFx.Fields([DevScopeFx.Secret, DevScopeFx.Code, DevScopeFx.Owner], [
            { field: DevScopeFx.Code, read: true },
            { field: DevScopeFx.Owner, read: true, create: true },
            { field: DevScopeFx.Secret, read: true, create: true, update: true },
        ])
        const fx = await DepthFx.Compile(read, DevScopeFx.P1, fields)
        assert.equal(fx.Depth.Hidden.get(DevScopeFx.Widget), undefined)
        assert.deepEqual([...fx.Depth.ReadOnly.get(DevScopeFx.Widget) ?? []].sort(), [DevScopeFx.Code, DevScopeFx.Owner], 'not writable at create or at update')
        assert.deepEqual([...fx.Depth.Scope().Writes.get(DevScopeFx.Widget)?.ReadOnly ?? []].sort(), [DevScopeFx.Code, DevScopeFx.Owner])
    })

    test('create defaults stamp the owner and the home unit', async () =>
    {
        const fx = await DepthFx.Compile([DevScopeFx.Privilege(PrivilegeAction.Create, AccessLevel.User)])
        assert.deepEqual([...fx.Depth.Defaults(DevScopeFx.Widget)], [[DevScopeFx.Owner, DevScopeFx.P1], [DevScopeFx.OwningBu, DevScopeFx.Sales]])
        assert.equal(fx.Depth.Defaults(DevScopeFx.Gadget).size, 0, 'a fixed unit stamps nothing')
        assert.equal(DevScopeFx.Admits(fx.Depth.Scope(), DevScopeFx.Widget, ScopeAxis.Create, Object.fromEntries(fx.Depth.Defaults(DevScopeFx.Widget))), true, 'a defaulted create passes its own Create rule')
    })
})
