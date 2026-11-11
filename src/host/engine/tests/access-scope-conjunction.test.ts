import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessDefault, AccessScope, IsNull } from '@pragmatic-tech-ai/graph'
import type { CellValue } from '@pragmatic-tech-ai/graph'
import { AccessLevel, PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import { AccessScopeConjunction } from '../access-scope-conjunction.js'
import { DepthScopeCompiler } from '../depth-scope-compiler.js'
import { EngineSchemaCatalog } from '../engine-schema-catalog.js'
import { DevScopeFx, ScopeAxis } from './dev-scope-fixture.js'

class ConjunctionFx
{
    public static readonly Class = 'class'
    public static readonly Axes: readonly ScopeAxis[] = [ScopeAxis.Read, ScopeAxis.Create, ScopeAxis.Update, ScopeAxis.Delete]
    public static readonly Concepts: readonly string[] = [DevScopeFx.Widget, DevScopeFx.Gizmo, DevScopeFx.Gadget, DevScopeFx.Term, DevScopeFx.Element]
    public static readonly Nodes: readonly Readonly<Record<string, CellValue>>[] = [
        { owner: DevScopeFx.P1, owningBu: DevScopeFx.Sales },
        { owner: DevScopeFx.P2, owningBu: DevScopeFx.North },
        {},
    ]

    /** A Default Allow scope with one always-true entry keyed on the reserved root, for reads and writes. */
    public static RootScope(): AccessScope
    {
        const always = new IsNull(ConjunctionFx.Class)
        return AccessScope.Build({
            Default: AccessDefault.Allow,
            Rows: new Map([[DevScopeFx.Element, always]]),
            Writes: new Map([[DevScopeFx.Element, { Create: always, Update: always, Delete: always }]]),
        })
    }
}

describe('AccessScopeConjunction', () =>
{
    test('an always-true scope on todl.Element keeps the Widget and Term decisions unchanged', async () =>
    {
        const { Auth } = await DevScopeFx.Authorization(DevScopeFx.Model([
            DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.User),
            DevScopeFx.Privilege(PrivilegeAction.Create, AccessLevel.Organization),
        ]))
        const context = DevScopeFx.Context(DevScopeFx.P1)
        const description = DevScopeFx.Description()
        const depth = DepthScopeCompiler.Compile(await Auth.EvaluatorForContext(context), context.Principal, description, await Auth.HasSecurityModelFor(context)).Scope()
        const combined = AccessScopeConjunction.And(ConjunctionFx.RootScope(), depth, new EngineSchemaCatalog(description))
        for (const concept of ConjunctionFx.Concepts)
        {
            for (const axis of ConjunctionFx.Axes)
            {
                for (const node of ConjunctionFx.Nodes)
                {
                    assert.equal(DevScopeFx.Admits(combined, concept, axis, node), DevScopeFx.Admits(depth, concept, axis, node), `${concept} ${axis} ${JSON.stringify(node)}`)
                }
            }
        }
        assert.equal(DevScopeFx.Admits(combined, DevScopeFx.Term, ScopeAxis.Read, {}), true, 'terms stay readable')
        assert.equal(DevScopeFx.Admits(combined, DevScopeFx.Widget, ScopeAxis.Read, ConjunctionFx.Nodes[0]!), true, 'p1\'s own Widget stays visible')
    })

    test('exact member sets are unioned and stay exact', async () =>
    {
        const description = DevScopeFx.Description()
        const exact = (members: readonly string[]): AccessScope => AccessScope.Build({
            Default: AccessDefault.Allow,
            HiddenExact: new Map([[DevScopeFx.Widget, new Set(members)]]),
            Writes: new Map([[DevScopeFx.Widget, { ReadOnlyExact: { Update: new Set(members) } }]]),
        })
        const combined = AccessScopeConjunction.And(exact([DevScopeFx.Secret]), exact([DevScopeFx.Code]), new EngineSchemaCatalog(description))
        assert.deepEqual([...combined.HiddenExact.get(DevScopeFx.Widget) ?? []].sort(), [DevScopeFx.Code, DevScopeFx.Secret])
        assert.deepEqual([...combined.Writes.get(DevScopeFx.Widget)?.ReadOnlyExact?.Update ?? []].sort(), [DevScopeFx.Code, DevScopeFx.Secret])
        assert.equal(combined.Hidden.size, 0)
        assert.equal(combined.Writes.get(DevScopeFx.Widget)?.ReadOnly, undefined)
    })
})
