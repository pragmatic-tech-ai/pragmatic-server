import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessDefault } from '@pragmatic-tech-ai/graph'
import type { CellValue } from '@pragmatic-tech-ai/graph'
import { AccessLevel, PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import type { IFieldSecurityConfig, IPrivilegeConfig, ISecurityModelConfig, Principal } from '@pragmatic-tech-ai/todl-identity'
import type { AccessDepthEvaluator } from '@pragmatic-tech-ai/todl-identity-engine'
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

    public static readonly Names = Object.keys(Instances.All)
}

/** One compiled depth scope and today's evaluator over the same model, compared instance by instance. */
class DepthCase
{
    public constructor(public readonly Depth: DepthScope, private readonly evaluator: AccessDepthEvaluator, private readonly principal: Principal)
    {
    }

    public static async Of(model: ISecurityModelConfig, principal: string = DevScopeFx.P1): Promise<DepthCase>
    {
        const { Auth } = await DevScopeFx.Authorization(model)
        const context = DevScopeFx.Context(principal)
        const evaluator = await Auth.EvaluatorForContext(context)
        return new DepthCase(DepthScopeCompiler.Compile(evaluator, context.Principal, DevScopeFx.Description(), await Auth.HasSecurityModelFor(context)), evaluator, context.Principal)
    }

    public static Compile(privileges: readonly IPrivilegeConfig[], fields?: IFieldSecurityConfig, principal: string = DevScopeFx.P1): Promise<DepthCase>
    {
        return DepthCase.Of(DevScopeFx.Model(privileges, fields), principal)
    }

    /** The instances the compiled scope admits on `axis` for a node of `concept`. */
    public Visible(axis: ScopeAxis, concept: string = DevScopeFx.Widget): string[]
    {
        const scope = this.Depth.Scope()
        return Instances.Names.filter(name => DevScopeFx.Admits(scope, concept, axis, Instances.All[name]!))
    }

    /** Today's per-instance decision (AccessDepthInstanceFilter / AccessDepthWriteInstanceGate) on the node's own concept. */
    public Expected(action: PrivilegeAction, concept: string = DevScopeFx.Widget): string[]
    {
        return Instances.Names.filter(name => this.evaluator.Allows(this.principal, action, { Concept: concept, Field: (field: string) => Instances.All[name]![field] as string | undefined }))
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
    public static readonly Concepts: readonly string[] = [DevScopeFx.Widget, DevScopeFx.Gizmo, DevScopeFx.Gear, DevScopeFx.Gadget]
    public static readonly Expected: Readonly<Record<AccessLevel, readonly string[]>> = {
        [AccessLevel.None]: [],
        [AccessLevel.User]: ['mine', 'team'],
        [AccessLevel.BusinessUnit]: ['mine', 'team', 'north', 'ownerless'],
        [AccessLevel.BusinessUnitAndChildren]: ['mine', 'team', 'east', 'deep', 'north', 'ownerless'],
        [AccessLevel.Organization]: Instances.Names,
    }

    /** Asserts the compiled scope decides every fixture concept and action exactly as the evaluator does. */
    public static AssertParity(depth: DepthCase): void
    {
        for (const concept of DepthFx.Concepts)
        {
            for (const [action, axis] of DepthFx.Actions)
            {
                assert.deepEqual(depth.Visible(axis, concept), depth.Expected(action, concept), `${concept} ${action}`)
            }
        }
    }
}

describe('DepthScopeCompiler: one access level per action, as today\'s evaluator decides it', () =>
{
    for (const level of DepthFx.Levels)
    {
        for (const [action, axis] of DepthFx.Actions)
        {
            test(`${level} ${action}`, async () =>
            {
                const depth = await DepthCase.Compile([DevScopeFx.Privilege(action, level)])
                assert.deepEqual(depth.Visible(axis), DepthFx.Expected[level])
                for (const [, other] of DepthFx.Actions.filter(([a]) => a !== action))
                {
                    assert.deepEqual(depth.Visible(other), [], 'a privilege grants only its own action')
                }
                DepthFx.AssertParity(depth)
            })
        }
    }
})

describe('DepthScopeCompiler ownership semantics', () =>
{
    test('teams count for user level', async () =>
    {
        const withTeam = await DepthCase.Compile([DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.User)])
        assert.ok(withTeam.Visible(ScopeAxis.Read).includes('team'), 'a record owned by the principal\'s team is visible')
        // p2 holds the same role through an override of its own: no team, so only its own records
        const model = DevScopeFx.Model([DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.User)])
        const p2 = await DepthCase.Of({ ...model, roleAssignment: { claimsMapping: [], teamRoles: [], overrides: [{ principalId: DevScopeFx.P2, roles: [DevScopeFx.Role] }] } }, DevScopeFx.P2)
        assert.deepEqual(p2.Visible(ScopeAxis.Read), ['east', 'deep', 'north', 'rooted', 'unset', 'bogus'])
        DepthFx.AssertParity(p2)
    })

    test('parent-child reach includes descendants', async () =>
    {
        const depth = await DepthCase.Compile([DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.BusinessUnitAndChildren)])
        const visible = depth.Visible(ScopeAxis.Read)
        assert.ok(visible.includes('east') && visible.includes('deep'), 'child and grandchild units of the home unit')
        assert.ok(visible.includes('north'), 'the team\'s unit is in reach')
        assert.ok(!visible.includes('rooted'), 'the parent of the home unit is not')
    })

    test('an unset, empty or unknown business unit value reads as the root unit (OwnershipResolver)', async () =>
    {
        const base = DevScopeFx.Model([DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.BusinessUnit)])
        const model = { ...base, teams: [...base.teams, { id: DevScopeFx.TeamRoot, name: 'R', owningBusinessUnit: DevScopeFx.Root }],
            membership: { claimsMapping: [], overrides: [{ principalId: DevScopeFx.P1, homeBusinessUnit: DevScopeFx.Sales, teams: [DevScopeFx.TeamRoot] }] } }
        const depth = await DepthCase.Of(model)
        assert.deepEqual(depth.Visible(ScopeAxis.Read), ['mine', 'rooted', 'unset', 'empty', 'bogus', 'ownerless'])
        DepthFx.AssertParity(depth)
    })

    test('a fixed owning unit is a constant', async () =>
    {
        const inReach = await DepthCase.Compile([DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.BusinessUnit, DevScopeFx.Gadget)])
        assert.deepEqual(inReach.Visible(ScopeAxis.Read, DevScopeFx.Gadget), Instances.Names, 'north is in p1\'s reach through team-a')
        DepthFx.AssertParity(inReach)
        const user = await DepthCase.Compile([DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.User, DevScopeFx.Gadget)])
        assert.deepEqual(user.Visible(ScopeAxis.Read, DevScopeFx.Gadget), [], 'Gadget has no owner: User level denies')
        assert.ok(user.Depth.Diagnostics.some(d => d.Code === DepthDiagnosticCode.NoOwner && d.Concept === DevScopeFx.Gadget))
    })

    test('a missing owner field compiles to False with a diagnostic', async () =>
    {
        const base = DevScopeFx.Model([DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.User)])
        const model = { ...base, ownershipRules: base.ownershipRules.map(rule => rule.concept === DevScopeFx.Widget ? { ...rule, owner: { kind: rule.owner!.kind, value: DevScopeFx.MissingField } } : rule) }
        const depth = await DepthCase.Of(model)
        assert.deepEqual(depth.Visible(ScopeAxis.Read), [])
        assert.ok(depth.Depth.Diagnostics.some(d => d.Code === DepthDiagnosticCode.MissingOwnerField && d.Concept === DevScopeFx.Widget))
    })

    test('a missing business-unit field compiles to False with a diagnostic (never the root fallback)', async () =>
    {
        const base = DevScopeFx.Model([DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.BusinessUnit)])
        // root in reach, so a root fallback would admit every instance: the missing FIELD must not fail open
        const model = { ...base,
            ownershipRules: base.ownershipRules.map(rule => rule.concept === DevScopeFx.Widget ? { ...rule, owningBusinessUnit: { kind: rule.owningBusinessUnit.kind, value: DevScopeFx.MissingField } } : rule),
            membership: { claimsMapping: [], overrides: [{ principalId: DevScopeFx.P1, homeBusinessUnit: DevScopeFx.Root, teams: [] }] } }
        const depth = await DepthCase.Of(model)
        assert.deepEqual(depth.Visible(ScopeAxis.Read), [])
        assert.ok(depth.Depth.Diagnostics.some(d => d.Code === DepthDiagnosticCode.MissingBusinessUnitField && d.Concept === DevScopeFx.Widget))
    })

    test('a non-String ownership field compiles to False with a diagnostic', async () =>
    {
        const depth = await DepthCase.Compile([DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.User, DevScopeFx.Counter)])
        assert.deepEqual(depth.Visible(ScopeAxis.Read, DevScopeFx.Counter), [])
        assert.ok(depth.Depth.Diagnostics.some(d => d.Code === DepthDiagnosticCode.NonStringOwnershipField && d.Concept === DevScopeFx.Counter))
    })
})

describe('DepthScopeCompiler judges each instance on its own concept (ConceptIs, R93)', () =>
{
    test('a concept without a privilege is denied', async () =>
    {
        const depth = await DepthCase.Compile([DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.Organization)])
        assert.equal(depth.Depth.Default, AccessDefault.Deny)
        assert.deepEqual(depth.Visible(ScopeAxis.Read, DevScopeFx.Gadget), [])
        DepthFx.AssertParity(depth)
    })

    test('an ungoverned subconcept stays denied under a granted parent', async () =>
    {
        const depth = await DepthCase.Compile([DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.Organization)])
        assert.deepEqual(depth.Visible(ScopeAxis.Read, DevScopeFx.Gizmo), [])
        DepthFx.AssertParity(depth)
    })

    test('child Org under parent User sees all children', async () =>
    {
        const depth = await DepthCase.Compile([
            DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.User),
            DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.Organization, DevScopeFx.Gizmo),
        ])
        assert.deepEqual(depth.Visible(ScopeAxis.Read, DevScopeFx.Gizmo), Instances.Names)
        assert.deepEqual(depth.Visible(ScopeAxis.Read, DevScopeFx.Widget), ['mine', 'team'])
        DepthFx.AssertParity(depth)
    })

    test('a governed child under an ungoverned middle concept is visible per its own level', async () =>
    {
        const depth = await DepthCase.Compile([
            DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.User),
            DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.BusinessUnit, DevScopeFx.Gear),
        ])
        assert.deepEqual(depth.Visible(ScopeAxis.Read, DevScopeFx.Gizmo), [], 'the middle concept is ungoverned')
        assert.deepEqual(depth.Visible(ScopeAxis.Read, DevScopeFx.Gear), DepthFx.Expected[AccessLevel.BusinessUnit])
        DepthFx.AssertParity(depth)
    })

    test('a child with no ownership rule can be created with defaults (the parent\'s User rule does not apply)', async () =>
    {
        const model = DevScopeFx.Model([
            DevScopeFx.Privilege(PrivilegeAction.Create, AccessLevel.User),
            DevScopeFx.Privilege(PrivilegeAction.Create, AccessLevel.Organization, DevScopeFx.Gizmo),
        ], undefined, false)
        const depth = await DepthCase.Of(model)
        assert.equal(depth.Depth.Defaults(DevScopeFx.Gizmo).size, 0, 'no ownership rule: nothing stamped')
        assert.equal(DevScopeFx.Admits(depth.Depth.Scope(), DevScopeFx.Gizmo, ScopeAxis.Create, Object.fromEntries(depth.Depth.Defaults(DevScopeFx.Gizmo))), true)
        assert.equal(DevScopeFx.Admits(depth.Depth.Scope(), DevScopeFx.Widget, ScopeAxis.Create, Object.fromEntries(depth.Depth.Defaults(DevScopeFx.Widget))), true, 'a defaulted Widget passes its own User rule')
        assert.equal(DevScopeFx.Admits(depth.Depth.Scope(), DevScopeFx.Widget, ScopeAxis.Create, {}), false)
    })

    test('skipped concept is allowed and never secured', async () =>
    {
        // the principal reads Widgets only and holds nothing on the root-level Gadget
        const { Auth } = await DevScopeFx.Authorization(DevScopeFx.Model([DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.Organization)], DevScopeFx.Fields([DevScopeFx.Secret, DevScopeFx.Code], [{ field: DevScopeFx.Code, read: true }])))
        const context = DevScopeFx.Context(DevScopeFx.P1)
        const evaluator = await Auth.EvaluatorForContext(context)
        const governed = DepthScopeCompiler.Compile(evaluator, context.Principal, DevScopeFx.Description(), true)
        const skipped = DepthScopeCompiler.Compile(evaluator, context.Principal, DevScopeFx.Description(), true, { Skip: concept => concept === DevScopeFx.Widget || concept === DevScopeFx.Gadget })
        for (const [, axis] of DepthFx.Actions)
        {
            assert.equal(DevScopeFx.Admits(governed.Scope(), DevScopeFx.Gadget, axis, {}), false, `governed ${axis}`)
            assert.equal(DevScopeFx.Admits(skipped.Scope(), DevScopeFx.Gadget, axis, {}), true, `skipped ${axis}: outside the depth scope`)
        }
        assert.equal(skipped.HiddenExact.has(DevScopeFx.Widget), false)
        assert.equal(skipped.ReadOnlyExact.has(DevScopeFx.Widget), false)
        assert.equal(governed.HiddenExact.has(DevScopeFx.Widget), true, 'the unskipped compile secures it')
        assert.equal(skipped.Defaults(DevScopeFx.Widget).size, 0)
        assert.deepEqual(skipped.Rows.get(DevScopeFx.Gizmo), governed.Rows.get(DevScopeFx.Gizmo), 'other concepts are unchanged')
        assert.deepEqual(skipped.Writes.get(DevScopeFx.Gizmo), governed.Writes.get(DevScopeFx.Gizmo))
    })

    test('taxonomy terms stay readable but not writable', async () =>
    {
        const depth = await DepthCase.Compile([])
        assert.equal(DevScopeFx.Admits(depth.Depth.Scope(), DevScopeFx.Term, ScopeAxis.Read, {}), true)
        assert.equal(DevScopeFx.Admits(depth.Depth.Scope(), DevScopeFx.Term, ScopeAxis.Create, {}), false)
    })

    test('no security model is deny all, terms included (ruling F-b)', async () =>
    {
        const { Auth } = await DevScopeFx.Authorization()
        const context = DevScopeFx.Context(DevScopeFx.P1)
        assert.equal(await Auth.HasSecurityModelFor(context), false)
        const depth = DepthScopeCompiler.Compile(await Auth.EvaluatorForContext(context), context.Principal, DevScopeFx.Description(), false)
        for (const concept of DepthFx.Concepts)
        {
            for (const [, axis] of DepthFx.Actions) assert.equal(DevScopeFx.Admits(depth.Scope(), concept, axis, Instances.All['mine']!), false, `${concept} ${axis}`)
        }
        assert.equal(DevScopeFx.Admits(depth.Scope(), DevScopeFx.Term, ScopeAxis.Read, {}), false)
        assert.equal(DevScopeFx.Admits(depth.Scope(), DevScopeFx.Term, ScopeAxis.Create, {}), false)
    })
})

describe('DepthScopeCompiler field security and create defaults', () =>
{
    const read = [DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.Organization)]

    test('secured readable field hidden without profile', async () =>
    {
        const depth = await DepthCase.Compile(read, DevScopeFx.Fields([DevScopeFx.Secret], []))
        assert.deepEqual([...depth.Depth.HiddenExact.get(DevScopeFx.Widget) ?? []], [DevScopeFx.Secret])
        assert.equal(depth.Depth.ReadOnlyExact.get(DevScopeFx.Widget), undefined, 'hidden members are not also read-only')
        assert.equal(depth.Depth.HiddenExact.has(DevScopeFx.Gadget), false, 'only the secured concept')
        assert.equal(depth.Depth.Scope().Hidden.size, 0, 'never through the inherited Hidden sets')
    })

    test('a field secured on a child only is hidden on the child, never on the parent', async () =>
    {
        const depth = await DepthCase.Compile(read, DevScopeFx.Fields([DevScopeFx.Secret], [], DevScopeFx.Gizmo))
        assert.deepEqual([...depth.Depth.HiddenExact.get(DevScopeFx.Gizmo) ?? []], [DevScopeFx.Secret])
        assert.equal(depth.Depth.HiddenExact.has(DevScopeFx.Widget), false)
    })

    test('a field secured on the parent is not hidden or read-only on a child unless the child secures it', async () =>
    {
        const hidden = await DepthCase.Compile(read, DevScopeFx.Fields([DevScopeFx.Secret], []))
        const scope = hidden.Depth.Scope()
        assert.deepEqual([...scope.HiddenExact.get(DevScopeFx.Widget) ?? []], [DevScopeFx.Secret])
        assert.equal(scope.HiddenExact.has(DevScopeFx.Gizmo), false)
        assert.equal(scope.Hidden.size, 0, 'exact sets only: the engine never extends them to Gizmo (R94)')
        const readOnly = await DepthCase.Compile(read, DevScopeFx.Fields([DevScopeFx.Code], [{ field: DevScopeFx.Code, read: true }]))
        const writes = readOnly.Depth.Scope().Writes
        assert.deepEqual([...writes.get(DevScopeFx.Widget)?.ReadOnlyExact?.Update ?? []], [DevScopeFx.Code])
        assert.equal(writes.get(DevScopeFx.Gizmo)?.ReadOnlyExact, undefined)
        assert.equal(writes.get(DevScopeFx.Widget)?.ReadOnly, undefined, 'never through the inherited ReadOnly sets')
    })

    test('readable but not writable field is read-only per operation', async () =>
    {
        const fields = DevScopeFx.Fields([DevScopeFx.Secret, DevScopeFx.Code, DevScopeFx.Owner], [
            { field: DevScopeFx.Code, read: true },
            { field: DevScopeFx.Owner, read: true, create: true },
            { field: DevScopeFx.Secret, read: true, create: true, update: true },
        ])
        const depth = await DepthCase.Compile(read, fields)
        assert.equal(depth.Depth.HiddenExact.get(DevScopeFx.Widget), undefined)
        const readOnly = depth.Depth.Scope().Writes.get(DevScopeFx.Widget)?.ReadOnlyExact
        assert.deepEqual([...readOnly?.Create ?? []], [DevScopeFx.Code], 'not writable at create')
        assert.deepEqual([...readOnly?.Update ?? []].sort(), [DevScopeFx.Code, DevScopeFx.Owner], 'not writable at update: owner is create-only')
    })

    test('create defaults stamp the owner and the home unit', async () =>
    {
        const depth = await DepthCase.Compile([DevScopeFx.Privilege(PrivilegeAction.Create, AccessLevel.User)])
        assert.deepEqual([...depth.Depth.Defaults(DevScopeFx.Widget)], [[DevScopeFx.Owner, DevScopeFx.P1], [DevScopeFx.OwningBu, DevScopeFx.Sales]])
        assert.equal(depth.Depth.Defaults(DevScopeFx.Gadget).size, 0, 'a fixed unit stamps nothing')
        assert.equal(DevScopeFx.Admits(depth.Depth.Scope(), DevScopeFx.Widget, ScopeAxis.Create, Object.fromEntries(depth.Depth.Defaults(DevScopeFx.Widget))), true, 'a defaulted create passes its own Create rule')
    })
})
