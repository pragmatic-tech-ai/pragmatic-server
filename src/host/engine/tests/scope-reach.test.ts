import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessDefault, AccessScope, ConceptIs, FalsePredicate, IsNull, Not, Or, TruePredicate } from '@pragmatic-tech-ai/graph'
import type { Predicate } from '@pragmatic-tech-ai/graph'
import { EngineSchemaCatalog } from '../engine-schema-catalog.js'
import { ScopeReach } from '../scope-reach.js'
import { DevScopeFx } from './dev-scope-fixture.js'

class ReachFx
{
    public static readonly Owner = 'owner'

    public static Scope(defaultAccess: AccessDefault, rows: readonly (readonly [string, Predicate])[]): AccessScope
    {
        return AccessScope.Build({ Default: defaultAccess, Rows: new Map(rows) })
    }
}

describe('ScopeReach', () =>
{
    test('False entry is unreachable', () =>
    {
        const catalog = new EngineSchemaCatalog(DevScopeFx.Description())
        const falseEntry = ReachFx.Scope(AccessDefault.Allow, [[DevScopeFx.Gadget, FalsePredicate.Instance]])
        assert.equal(ScopeReach.MayRead(falseEntry, DevScopeFx.Gadget, catalog), false, 'a constant False entry hides every instance')
        assert.equal(ScopeReach.MayRead(falseEntry, DevScopeFx.Widget, catalog), true, 'an unrelated concept falls to Default Allow')
        // the depth compiler's own-concept guard (R93) folds to False for the concept's own instances
        const guarded = ReachFx.Scope(AccessDefault.Deny, [
            [DevScopeFx.Widget, new Not(new ConceptIs(DevScopeFx.Widget))],
            [DevScopeFx.Gizmo, new Or([new Not(new ConceptIs(DevScopeFx.Gizmo)), FalsePredicate.Instance])],
            [DevScopeFx.Gear, new Not(new ConceptIs(DevScopeFx.Gear))],
        ])
        assert.equal(ScopeReach.MayRead(guarded, DevScopeFx.Widget, catalog), false, 'every own-concept guard denies: unreachable')
    })

    test('deny default without entry is unreachable', () =>
    {
        const catalog = new EngineSchemaCatalog(DevScopeFx.Description())
        const deny = ReachFx.Scope(AccessDefault.Deny, [[DevScopeFx.Widget, TruePredicate.Instance]])
        assert.equal(ScopeReach.MayRead(deny, DevScopeFx.Gadget, catalog), false, 'no applicable entry under Default Deny')
        assert.equal(ScopeReach.MayRead(deny, DevScopeFx.Gizmo, catalog), true, 'an ancestor entry applies')
        assert.equal(ScopeReach.MayRead(deny, DevScopeFx.Element, catalog), true, 'the root covers a readable Widget')
        assert.equal(ScopeReach.MayRead(ReachFx.Scope(AccessDefault.Deny, []), DevScopeFx.Element, catalog), false, 'nothing readable: not even the root')
    })

    test('conditional entry is reachable', () =>
    {
        const catalog = new EngineSchemaCatalog(DevScopeFx.Description())
        const conditional = ReachFx.Scope(AccessDefault.Deny, [[DevScopeFx.Gadget, new IsNull(ReachFx.Owner)]])
        assert.equal(ScopeReach.MayRead(conditional, DevScopeFx.Gadget, catalog), true, 'a per-node predicate is "maybe"')
        const subconcept = ReachFx.Scope(AccessDefault.Deny, [
            [DevScopeFx.Widget, new Not(new ConceptIs(DevScopeFx.Widget))],
            [DevScopeFx.Gizmo, new Or([new Not(new ConceptIs(DevScopeFx.Gizmo)), FalsePredicate.Instance])],
            [DevScopeFx.Gear, TruePredicate.Instance],
        ])
        assert.equal(ScopeReach.MayRead(subconcept, DevScopeFx.Gizmo, catalog), true, 'a Gizmo concept covers its readable Gear subconcept')
    })
})
