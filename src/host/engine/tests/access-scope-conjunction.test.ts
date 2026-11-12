import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessDefault, AccessScope, And, IsNull } from '@pragmatic-tech-ai/graph'
import type { IEndpointMembers, IWriteRules } from '@pragmatic-tech-ai/graph'
import { AccessScopeConjunction } from '../access-scope-conjunction.js'
import { EngineSchemaCatalog } from '../engine-schema-catalog.js'
import { DevScopeFx } from './dev-scope-fixture.js'

class ConjunctionFx
{
    public static readonly Class = 'class'
    public static readonly Label = 'label'
    public static readonly From = 'from'
    public static readonly To = 'to'
    public static readonly Other = 'other'

    public static Writes(key: string, rules: IWriteRules): AccessScope
    {
        return AccessScope.Build({ Default: AccessDefault.Allow, Writes: new Map([[key, rules]]) })
    }

    public static Edges(members: IEndpointMembers): AccessScope
    {
        return AccessScope.Build({ Default: AccessDefault.Allow, Endpoints: new Map([[DevScopeFx.Gadget, members]]) })
    }

    public static Catalog(): EngineSchemaCatalog
    {
        return new EngineSchemaCatalog(DevScopeFx.Description())
    }
}

describe('AccessScopeConjunction', () =>
{
    test('conjunction keeps Append and AppendTo', () =>
    {
        const left = new IsNull(ConjunctionFx.Class)
        const right = new IsNull(ConjunctionFx.Label)
        const combined = AccessScopeConjunction.And(
            ConjunctionFx.Writes(DevScopeFx.Widget, { Append: left, AppendTo: left }),
            ConjunctionFx.Writes(DevScopeFx.Widget, { Append: right }),
            ConjunctionFx.Catalog())
        const rules = combined.Writes.get(DevScopeFx.Widget)
        assert.ok(rules?.Append instanceof And, 'both scopes\' Append predicates are ANDed')
        assert.deepEqual((rules.Append as And).Terms, [left, right])
        assert.equal(rules.AppendTo, left, 'a one-sided AppendTo is kept')
    })

    test('conjunction carries Endpoints', () =>
    {
        const members = { From: ConjunctionFx.From, To: ConjunctionFx.To }
        const combined = AccessScopeConjunction.And(ConjunctionFx.Edges(members), AccessScope.Build({ Default: AccessDefault.Allow }), ConjunctionFx.Catalog())
        assert.deepEqual(combined.Endpoints.get(DevScopeFx.Gadget), members, 'a one-sided entry is kept (the union)')
        const same = AccessScopeConjunction.And(ConjunctionFx.Edges(members), ConjunctionFx.Edges({ ...members }), ConjunctionFx.Catalog())
        assert.deepEqual(same.Endpoints.get(DevScopeFx.Gadget), members)
        assert.throws(() => AccessScopeConjunction.And(ConjunctionFx.Edges(members), ConjunctionFx.Edges({ From: ConjunctionFx.Other, To: ConjunctionFx.To }), ConjunctionFx.Catalog()),
            'two endpoint pairs for one edge concept are a host bug')
    })

    test('exact member sets are unioned and stay exact', () =>
    {
        const exact = (members: readonly string[]): AccessScope => AccessScope.Build({
            Default: AccessDefault.Allow,
            HiddenExact: new Map([[DevScopeFx.Widget, new Set(members)]]),
            Writes: new Map([[DevScopeFx.Widget, { ReadOnlyExact: { Update: new Set(members) } }]]),
        })
        const combined = AccessScopeConjunction.And(exact([DevScopeFx.Secret]), exact([DevScopeFx.Code]), ConjunctionFx.Catalog())
        assert.deepEqual([...combined.HiddenExact.get(DevScopeFx.Widget) ?? []].sort(), [DevScopeFx.Code, DevScopeFx.Secret])
        assert.deepEqual([...combined.Writes.get(DevScopeFx.Widget)?.ReadOnlyExact?.Update ?? []].sort(), [DevScopeFx.Code, DevScopeFx.Secret])
        assert.equal(combined.Hidden.size, 0)
        assert.equal(combined.Writes.get(DevScopeFx.Widget)?.ReadOnly, undefined)
    })
})
