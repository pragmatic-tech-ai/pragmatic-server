import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessDefault, AccessScope, Cypher, FalsePredicate, GraphError, GraphErrorCode, IdIn } from '@pragmatic-tech-ai/graph'
import type { GraphEngine, ISchemaDescription, ISignal, ISubscription } from '@pragmatic-tech-ai/graph'
import { TodlNames, TodlNodePlacement } from '@pragmatic-tech-ai/todl/engine'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import { Signal } from '@pragmatic-tech-ai/todl-runtime'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { AccessScopeConjunction } from '../access-scope-conjunction.js'
import { AccessScopeSource } from '../access-scope-source.js'
import type { IPreparedRules, IScopeDiagnostics, IScopeRecords, IScopeRules, ScopeSchema } from '../access-scope-source.js'
import { PrincipalFacts } from '../principal-facts.js'
import { DevScopeRules } from '../dev-scope-rules.js'
import { DevGraphEngineHost } from '../dev-graph-engine-host.js'
import type { IDevEngineDiagnostics, IDevGraphEngine } from '../dev-graph-engine-host.js'
import type { IWriteFence } from '../server-model-workspace.js'
import type { DevSnapshot } from '../dev-snapshot-source.js'
import { FakeLanguageService, FakeSolution, HeldFence, MemoryStorage } from './engine-host-fixture.js'
import { DevScopeFx } from './dev-scope-fixture.js'

class SilentDiagnostics implements IDevEngineDiagnostics
{
    public UpgradeFailed(): void
    {
    }

    public CatalogFailed(): void
    {
    }

    public RetireFailed(): void
    {
    }

    public ChangedHandlerFailed(): void
    {
    }

    public WritesUnsettled(): void
    {
    }

    public DrainUnsettled(): void
    {
    }
}

class RecordingScopeDiagnostics implements IScopeDiagnostics
{
    public readonly Messages: string[] = []

    public ScopeDiagnostics(messages: readonly string[]): void
    {
        this.Messages.push(...messages)
    }
}

/** The real dev engine host, with a `Changed` the test raises by hand (an upgrade without recompiling). */
class ProbeHost implements IDevGraphEngine
{
    public readonly Changed: ISignal<void>
    private readonly signal = new Signal<void>()

    public constructor(public readonly Inner: DevGraphEngineHost)
    {
        this.Changed = { Subscribe: (handler: (value: void) => void): ISubscription => this.signal.subscribe(handler) }
    }

    public Engine(): Promise<GraphEngine>
    {
        return this.Inner.Engine()
    }

    public ResetConnectors(): void
    {
        this.Inner.ResetConnectors()
    }

    public Description(): Promise<ISchemaDescription>
    {
        return this.Inner.Description()
    }

    public Snapshot(): Promise<DevSnapshot>
    {
        return this.Inner.Snapshot()
    }

    public WhenUpgraded(): Promise<void>
    {
        return this.Inner.WhenUpgraded()
    }

    public WhenWritesSettled(): Promise<void>
    {
        return this.Inner.WhenWritesSettled()
    }

    public InstallWriteFence(fence: IWriteFence): IDisposable
    {
        return this.Inner.InstallWriteFence(fence)
    }

    public Raise(): void
    {
        this.signal.emit(undefined)
    }
}

/** One dev solution member declaring acme.Widget / acme.Gadget and model acme.Shop (w1..w3, g1). */
class SourceFx
{
    public static readonly Model = 'acme.Shop'
    public static readonly Widgets = 'MATCH (w:acme.Widget) RETURN w.code AS c ORDER BY c'
    public static readonly Gadgets = 'MATCH (g:acme.Gadget) RETURN g.code AS c ORDER BY c'
    public static readonly Create = "CREATE (w:acme.Widget {code: 'w9'}) RETURN w.code AS c"
    public static readonly Created = "MATCH (w:acme.Widget {code: 'w9'}) RETURN w.owner AS o, w.owningBu AS b"
    public static readonly FirstWidget = "MATCH (w:acme.Widget {code: 'w1'}) RETURN w"
    public static readonly FirstGadget = "MATCH (g:acme.Gadget {code: 'g1'}) RETURN g"
    private static readonly Source = 'namespace acme {\n'
        + '  concept Widget { owner : string?; owningBu : string?; secret : string?; code : string?; }\n'
        + '  concept Gadget { code : string?; }\n'
        + '  concept Gizmo : Widget { }\n'
        + '  taxonomy Kinds : represents Widget { term Big { } }\n'
        + '  model Shop : acme {\n'
        + '    Widget w1 { owner = "p1"; owningBu = "sales"; code = "w1"; secret = "s1"; }\n'
        + '    Widget w2 { owner = "p2"; owningBu = "north"; code = "w2"; secret = "s2"; }\n'
        + '    Widget w3 { owner = "p2"; owningBu = "root"; code = "w3"; }\n'
        + '    Gadget g1 { code = "g1"; }\n'
        + '    Gizmo z1 { owner = "p2"; owningBu = "root"; code = "z1"; secret = "z"; }\n'
        + '  }\n'
        + '}\n'

    public readonly Storage: MemoryStorage
    public readonly Lang = new FakeLanguageService()
    public readonly Host: ProbeHost

    public constructor()
    {
        this.Storage = new MemoryStorage('mem/acme', { 'model.todl': SourceFx.Source })
        const solution = new FakeSolution('sol', [{ Storage: this.Storage }])
        this.Host = new ProbeHost(new DevGraphEngineHost(() => Promise.resolve(solution), () => Promise.resolve(this.Lang), undefined, new SilentDiagnostics()))
        // the test writes straight through the engine, without DevCypherExecute's lease: writes fail closed without a fence
        this.Host.InstallWriteFence(HeldFence.Instance)
    }

    public static async Column(engine: GraphEngine, scope: AccessScope, query: string): Promise<unknown[]>
    {
        const result = await new Cypher.CypherEngine(engine).Execute(scope, query)
        return result.Rows.map(row => (row[0] instanceof Cypher.ScalarValue ? row[0].Value : null))
    }

    /** The public id of the one node `query` returns under the System scope. */
    public static async IdOf(engine: GraphEngine, query: string): Promise<string>
    {
        return ((await new Cypher.CypherEngine(engine).Execute(AccessScope.System, query)).Rows[0]![0] as Cypher.NodeValue).Id
    }

}

/** Scope rules the test drives: the record part it hands out, a Finish confining to `Only`, a digest and a Changed it raises. */
class FakeRules implements IScopeRules
{
    public static readonly First = 'rules-1'
    public static readonly Second = 'rules-2'

    public readonly Changed: ISignal<void>
    public Digest = FakeRules.First
    public Record = AccessScope.Build({ Default: AccessDefault.Allow })
    public Only: ReadonlySet<string> | undefined
    public Finished: AccessScope | undefined
    public Compiles = 0
    public Diagnostics: readonly string[] = []
    public Disposed = false
    private readonly signal = new Signal<void>()

    public constructor()
    {
        this.Changed = { Subscribe: (handler: (value: void) => void): ISubscription => this.signal.subscribe(handler) }
    }

    public Prepare(schema: ScopeSchema): Promise<IPreparedRules>
    {
        return Promise.resolve(new FakePrepared(this, schema))
    }

    public Raise(): void
    {
        this.signal.emit(undefined)
    }

    public dispose(): void
    {
        this.Disposed = true
    }
}

class FakePrepared implements IPreparedRules
{
    public readonly Digest: string

    public constructor(private readonly rules: FakeRules, private readonly schema: ScopeSchema)
    {
        this.Digest = rules.Digest
    }

    public Records(): Promise<IScopeRecords>
    {
        this.rules.Compiles += 1
        return Promise.resolve({ Scope: this.rules.Record, Diagnostics: this.rules.Diagnostics, Principal: PrincipalFacts.None })
    }

    public Finish(scope: AccessScope, _context: AccessContext): Promise<AccessScope>
    {
        this.rules.Finished = scope
        if (this.rules.Only === undefined) return Promise.resolve(scope)
        const only = AccessScope.Build({ Default: AccessDefault.Allow, Rows: new Map([[TodlNames.Element, new IdIn(this.rules.Only)]]) })
        return Promise.resolve(AccessScopeConjunction.And(scope, only, this.schema.Catalog))
    }

    public Placement(_principal: PrincipalFacts, modelId: string | undefined): Cypher.INodePlacement
    {
        return new TodlNodePlacement(modelId!, modelId!)
    }
}

/** A scope source over a fresh fixture; disposed after each test. */
class ScopeFx
{
    private static readonly Open: (() => Promise<void>)[] = []

    public readonly Source: SourceFx
    public readonly Scopes: AccessScopeSource
    public readonly Diagnostics: RecordingScopeDiagnostics

    private constructor(source: SourceFx, scopes: AccessScopeSource, diagnostics: RecordingScopeDiagnostics)
    {
        this.Source = source
        this.Scopes = scopes
        this.Diagnostics = diagnostics
    }

    /** A scope source under the test's own rules. */
    public static WithRules(rules: FakeRules): ScopeFx
    {
        const source = new SourceFx()
        const diagnostics = new RecordingScopeDiagnostics()
        const fx = new ScopeFx(source, new AccessScopeSource(source.Host, rules, diagnostics), diagnostics)
        ScopeFx.Track(fx)
        return fx
    }

    public static Anonymous(): ScopeFx
    {
        const source = new SourceFx()
        const diagnostics = new RecordingScopeDiagnostics()
        const fx = new ScopeFx(source, new AccessScopeSource(source.Host, new DevScopeRules(), diagnostics), diagnostics)
        ScopeFx.Track(fx)
        return fx
    }

    public static async DisposeAll(): Promise<void>
    {
        for (const dispose of ScopeFx.Open.splice(0)) await dispose()
    }

    public async Engine(): Promise<GraphEngine>
    {
        return this.Source.Host.Engine()
    }

    public async Column(principal: string, query: string): Promise<unknown[]>
    {
        const scope = await this.Scopes.ScopeFor(DevScopeFx.Context(principal))
        return SourceFx.Column(await this.Engine(), scope.Scope, query)
    }

    public async Write(principal: string, query: string): Promise<unknown>
    {
        const scope = await this.Scopes.ScopeFor(DevScopeFx.Context(principal))
        return new Cypher.CypherEngine(await this.Engine()).Execute(scope.Scope, query, { Placement: scope.Placement(SourceFx.Model) })
    }

    private static Track(fx: ScopeFx): void
    {
        ScopeFx.Open.push(async () =>
        {
            fx.Scopes.dispose()
            await fx.Source.Host.Inner.dispose()
        })
    }
}

describe('AccessScopeSource', () =>
{
    afterEach(() => ScopeFx.DisposeAll())

    test('the compiled scopes are an LRU of at most MaxScopes principals (M8)', async () =>
    {
        const fx = ScopeFx.Anonymous()
        const first = await fx.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P1))
        for (let n = 0; n < AccessScopeSource.MaxScopes + 5; n++)
        {
            await fx.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P1 + String(n)))
            // touching p1 keeps it the most recently used
            assert.equal((await fx.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P1))).Scope, first.Scope)
        }
        assert.equal(fx.Scopes.CachedScopes, AccessScopeSource.MaxScopes)
        assert.equal((await fx.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P1))).Scope, first.Scope, 'the most recently used scope survives')
    })

    test('no identity allows all', async () =>
    {
        const fx = ScopeFx.Anonymous()
        const scope = await fx.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P1))
        assert.equal(scope.Scope.Rows.size, 0)
        assert.equal(scope.Scope.Writes.size, 0)
        assert.deepEqual(await fx.Column(DevScopeFx.P1, SourceFx.Widgets), ['w1', 'w2', 'w3', 'z1'])
        assert.deepEqual(await fx.Column(DevScopeFx.P1, SourceFx.Gadgets), ['g1'])
        await fx.Write(DevScopeFx.P1, SourceFx.Create)
        assert.deepEqual(await SourceFx.Column(await fx.Engine(), AccessScope.System, SourceFx.Created), [null], 'no identity: no create defaults')
    })

    test('scope cached per principal and claims, dropped on host Changed', async () =>
    {
        const fx = ScopeFx.Anonymous()
        const first = await fx.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P1))
        assert.equal((await fx.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P1))).Scope, first.Scope, 'same principal, same schema: cached')
        const claimed = await fx.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P1, new Map([['dept', 'x']])))
        assert.notEqual(claimed.Digest, first.Digest, 'claims are part of the key')
        assert.ok(!claimed.Digest.includes('dept') && !claimed.Digest.includes('"x"'), 'claims are hashed, never carried')
        assert.notEqual((await fx.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P2))).Digest, first.Digest, 'another principal')
        assert.ok(first.Digest.includes((await fx.Engine()).SchemaVersion), 'the engine schema version keys it')
        fx.Source.Host.Raise()
        assert.equal(fx.Scopes.CachedScopes, 0, 'dropped on host Changed')
    })

    test('scope validates against the engine schema', async () =>
    {
        const fx = ScopeFx.Anonymous()
        const rules = new FakeRules()
        rules.Record = AccessScope.Build({ Default: AccessDefault.Allow, Hidden: new Map([[DevScopeFx.Widget, new Set([DevScopeFx.MissingField])]]) })
        const bad = ScopeFx.WithRules(rules)
        // the engine really validates: a scope naming what the schema lacks is refused, and never handed out
        await assert.rejects((await fx.Engine()).BeginRead(rules.Record), (error: unknown) => error instanceof GraphError && error.GraphCode === GraphErrorCode.InvalidArgument)
        await assert.rejects(bad.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P1)), (error: unknown) => error instanceof GraphError)
    })

    test('record diagnostics are reported once', async () =>
    {
        const rules = new FakeRules()
        rules.Diagnostics = [SourceFx.Model]
        const fx = ScopeFx.WithRules(rules)
        await fx.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P1))
        await fx.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P2))
        assert.deepEqual(fx.Diagnostics.Messages, [SourceFx.Model])
    })

    test('placement uses the model namespace and the model as owner', async () =>
    {
        const fx = ScopeFx.Anonymous()
        const scope = await fx.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P1))
        const place = scope.Placement(SourceFx.Model).Place(DevScopeFx.Widget, new Map())
        assert.match(place.PublicId, /^acme\./)
        assert.equal(place.Owner, SourceFx.Model)
        assert.equal(place.Defaults, undefined)
    })

    test('rules records are the scope record part', async () =>
    {
        const rules = new FakeRules()
        const fx = ScopeFx.WithRules(rules)
        const scope = await fx.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P1))
        assert.equal(scope.Scope, rules.Record, 'no depth is composed on top of the records')
        assert.deepEqual(await fx.Column(DevScopeFx.P1, SourceFx.Widgets), ['w1', 'w2', 'w3', 'z1'])
    })

    test('rules finish is applied last', async () =>
    {
        const rules = new FakeRules()
        const fx = ScopeFx.WithRules(rules)
        // the record part denies every Gadget; Finish then confines to w1 and g1, on top of it
        rules.Record = AccessScope.Build({ Default: AccessDefault.Allow, Rows: new Map([[DevScopeFx.Gadget, FalsePredicate.Instance]]) })
        rules.Only = new Set([await SourceFx.IdOf(await fx.Engine(), SourceFx.FirstWidget), await SourceFx.IdOf(await fx.Engine(), SourceFx.FirstGadget)])
        assert.deepEqual(await fx.Column(DevScopeFx.P1, SourceFx.Widgets), ['w1'], 'Finish narrows the records')
        assert.deepEqual(await fx.Column(DevScopeFx.P1, SourceFx.Gadgets), [], 'Finish cannot widen what the records deny')
        assert.equal(rules.Finished, rules.Record, 'Finish is given the record part')
    })

    test('rules digest keys the cache', async () =>
    {
        const rules = new FakeRules()
        const fx = ScopeFx.WithRules(rules)
        const first = await fx.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P1))
        await fx.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P1))
        assert.equal(rules.Compiles, 1)
        rules.Digest = FakeRules.Second
        const second = await fx.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P1))
        assert.equal(rules.Compiles, 2)
        assert.notEqual(second.Digest, first.Digest)
        assert.ok(second.Digest.includes(FakeRules.Second))
    })

    test('rules Changed drops the cache', async () =>
    {
        const rules = new FakeRules()
        const fx = ScopeFx.WithRules(rules)
        let dropped = 0
        const subscription = fx.Scopes.Dropped.Subscribe(() => { dropped += 1 })
        await fx.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P1))
        rules.Raise()
        assert.equal(dropped, 1)
        assert.equal(fx.Scopes.CachedScopes, 0)
        await fx.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P1))
        assert.equal(rules.Compiles, 2)
        subscription.dispose()
    })
})
