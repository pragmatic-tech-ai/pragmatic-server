import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessDefault, AccessError, AccessErrorCode, AccessScope, Cypher, FalsePredicate, GraphError, GraphErrorCode, IdIn } from '@pragmatic-tech-ai/graph'
import type { GraphEngine, ISchemaDescription, ISignal, ISubscription } from '@pragmatic-tech-ai/graph'
import { TodlNames, TodlNodePlacement } from '@pragmatic-tech-ai/todl/engine'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import { AccessLevel, PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { Signal } from '@pragmatic-tech-ai/todl-runtime'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import type { TenantReadAuthorization } from '../../cypher/read-filter-source.js'
import { AccessScopeConjunction } from '../access-scope-conjunction.js'
import { AccessScopeSource, NoPlacementDefaults } from '../access-scope-source.js'
import type { IPreparedRules, IScopeDiagnostics, IScopeRecords, IScopeRules, ScopeSchema } from '../access-scope-source.js'
import type { IPlacementDefaults } from '../depth-scope-compiler.js'
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
    public static readonly Secrets = 'MATCH (w:acme.Widget) RETURN w.secret AS s ORDER BY s'
    public static readonly Create = "CREATE (w:acme.Widget {code: 'w9'}) RETURN w.code AS c"
    public static readonly CreateFor = "CREATE (w:acme.Widget {code: 'w8', owner: 'p2'}) RETURN w.code AS c"
    public static readonly Created = "MATCH (w:acme.Widget {code: 'w9'}) RETURN w.owner AS o, w.owningBu AS b"
    public static readonly CreateGadget = "CREATE (g:acme.Gadget {code: 'g9'}) RETURN g.code AS c"
    public static readonly SetCode = "MATCH (w:acme.Widget {code: 'w1'}) SET w.code = 'w1x'"
    public static readonly Unknown = 'acme.Nope'
    public static readonly Gizmos = 'MATCH (g:acme.Gizmo) RETURN g.code AS c ORDER BY c'
    public static readonly GizmoSecrets = 'MATCH (g:acme.Gizmo) RETURN g.secret AS s'
    public static readonly SetGizmoCode = "MATCH (g:acme.Gizmo {code: 'z1'}) SET g.code = 'z1x'"
    public static readonly SetOwner = "MATCH (w:acme.Widget {code: 'w1'}) SET w.owner = 'p1'"
    public static readonly CreateOwned = "CREATE (w:acme.Widget {code: 'w7', owner: 'p1'}) RETURN w.code AS c"
    public static readonly SetSecret = "MATCH (w:acme.Widget {code: 'w1'}) SET w.secret = 'x'"
    public static readonly FirstWidget = "MATCH (w:acme.Widget {code: 'w1'}) RETURN w"
    public static readonly FirstGadget = "MATCH (g:acme.Gadget {code: 'g1'}) RETURN g"
    public static readonly AllNodes = 'MATCH (n) RETURN n.code AS c'
    public static readonly Terms = 'MATCH (t:todl.Term) RETURN t.taxonomy AS c'
    public static readonly CreateOrg = DevScopeFx.Privilege(PrivilegeAction.Create, AccessLevel.Organization)
    public static readonly ReadOrg = DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.Organization)
    public static readonly ReadUser = DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.User)
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

    public static Denied(error: unknown): boolean
    {
        return error instanceof Cypher.CypherWriteError && error.WriteCode === Cypher.CypherWriteErrorCode.Denied
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
        return Promise.resolve({ Scope: this.rules.Record, Diagnostics: [], Defaults: NoPlacementDefaults.Instance })
    }

    public Finish(scope: AccessScope, _context: AccessContext): Promise<AccessScope>
    {
        this.rules.Finished = scope
        if (this.rules.Only === undefined) return Promise.resolve(scope)
        const only = AccessScope.Build({ Default: AccessDefault.Allow, Rows: new Map([[TodlNames.Element, new IdIn(this.rules.Only)]]) })
        return Promise.resolve(AccessScopeConjunction.And(scope, only, this.schema.Catalog))
    }

    public Placement(_defaults: IPlacementDefaults, modelId: string | undefined): Cypher.INodePlacement
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

    public static async With(model: ISecurityModelConfig | undefined): Promise<{ Fx: ScopeFx; Auth: TenantReadAuthorization; Store: Awaited<ReturnType<typeof DevScopeFx.Authorization>>['Store'] }>
    {
        const { Auth, Store } = await DevScopeFx.Authorization(model)
        const source = new SourceFx()
        const diagnostics = new RecordingScopeDiagnostics()
        const fx = new ScopeFx(source, new AccessScopeSource(source.Host, new DevScopeRules(source.Host, Auth, true), diagnostics), diagnostics)
        ScopeFx.Track(fx)
        return { Fx: fx, Auth, Store }
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
        const fx = new ScopeFx(source, new AccessScopeSource(source.Host, new DevScopeRules(source.Host, undefined, false), diagnostics), diagnostics)
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

    test('no security model is deny all', async () =>
    {
        const { Fx } = await ScopeFx.With(undefined)
        assert.deepEqual(await Fx.Column(DevScopeFx.P1, SourceFx.Widgets), [])
        assert.deepEqual(await Fx.Column(DevScopeFx.P1, SourceFx.Gadgets), [])
        // ruling F-b: no security model reads nothing at all, taxonomy terms included
        assert.deepEqual(await Fx.Column(DevScopeFx.P1, SourceFx.AllNodes), [])
        assert.deepEqual(await Fx.Column(DevScopeFx.P1, SourceFx.Terms), [])
        await assert.rejects(Fx.Write(DevScopeFx.P1, SourceFx.Create), SourceFx.Denied)
    })

    test('depth scope reads and writes through the engine, with create defaults placed', async () =>
    {
        const { Fx } = await ScopeFx.With(DevScopeFx.Model([SourceFx.ReadUser, DevScopeFx.Privilege(PrivilegeAction.Create, AccessLevel.User)]))
        assert.deepEqual(await Fx.Column(DevScopeFx.P1, SourceFx.Widgets), ['w1'])
        assert.deepEqual(await Fx.Column(DevScopeFx.P1, SourceFx.Gadgets), [], 'ungoverned concept stays denied')
        await Fx.Write(DevScopeFx.P1, SourceFx.Create)
        const engine = await Fx.Engine()
        assert.deepEqual((await new Cypher.CypherEngine(engine).Execute(AccessScope.System, SourceFx.Created)).Rows.map(r => r.map(c => (c as Cypher.ScalarValue).Value)), [[DevScopeFx.P1, DevScopeFx.Sales]])
        await assert.rejects(Fx.Write(DevScopeFx.P1, SourceFx.CreateFor), SourceFx.Denied, 'a query-set owner wins over the default and must pass the Create rule')
        await assert.rejects(Fx.Write(DevScopeFx.P1, SourceFx.CreateGadget), SourceFx.Denied)
    })

    test('secured field reads as hidden and its read-only twin refuses writes', async () =>
    {
        const update = DevScopeFx.Privilege(PrivilegeAction.Update, AccessLevel.Organization)
        const hidden = await ScopeFx.With(DevScopeFx.Model([SourceFx.ReadOrg], DevScopeFx.Fields([DevScopeFx.Secret], [])))
        assert.deepEqual(await hidden.Fx.Column(DevScopeFx.P1, SourceFx.Secrets), [null, null, null])
        const readOnly = await ScopeFx.With(DevScopeFx.Model([SourceFx.ReadOrg, update], DevScopeFx.Fields([DevScopeFx.Code], [{ field: DevScopeFx.Code, read: true }])))
        await assert.rejects(readOnly.Fx.Write(DevScopeFx.P1, SourceFx.SetCode), SourceFx.Denied)
        assert.deepEqual(await readOnly.Fx.Column(DevScopeFx.P1, SourceFx.Widgets), ['w1', 'w2', 'w3'])
    })

    test('scope cached per principal and dropped on security model reload', async () =>
    {
        const { Fx, Auth, Store } = await ScopeFx.With(DevScopeFx.Model([SourceFx.ReadUser]))
        const first = await Fx.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P1))
        assert.equal((await Fx.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P1))).Scope, first.Scope, 'same principal, same schema: cached')
        assert.notEqual((await Fx.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P2))).Scope, first.Scope, 'another principal')
        assert.notEqual((await Fx.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P1, new Map([['dept', 'x']])))).Scope, first.Scope, 'claims are part of the key')
        await DevScopeFx.Save(Store, DevScopeFx.Model([SourceFx.ReadOrg]))
        assert.deepEqual(await Fx.Column(DevScopeFx.P1, SourceFx.Widgets), ['w1'], 'stale until the model is invalidated')
        Auth.Invalidate(DevScopeFx.TenantId)
        assert.deepEqual(await Fx.Column(DevScopeFx.P1, SourceFx.Widgets), ['w1', 'w2', 'w3'], 'reloaded live')
        const reloaded = await Fx.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P1))
        Fx.Source.Host.Raise()
        assert.notEqual((await Fx.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P1))).Scope, reloaded.Scope, 'dropped on host Changed')
    })

    test('digest is the principal digest and the engine schema version', async () =>
    {
        const { Fx } = await ScopeFx.With(DevScopeFx.Model([SourceFx.ReadUser]))
        const scope = await Fx.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P1))
        const version = (await Fx.Engine()).SchemaVersion
        assert.ok(scope.Digest.includes(version))
        assert.notEqual((await Fx.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P2))).Digest, scope.Digest)
    })

    test('scope validates against the engine schema', async () =>
    {
        // the model governs acme.Nope and owns acme.Gear / acme.Counter, which this schema lacks; the owner field of Widget is renamed away
        const base = DevScopeFx.Model([SourceFx.ReadUser, DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.Organization, SourceFx.Unknown)], DevScopeFx.Fields([DevScopeFx.MissingField, DevScopeFx.Secret], []))
        const model = { ...base, ownershipRules: base.ownershipRules.map(rule => rule.concept === DevScopeFx.Widget ? { ...rule, owner: { kind: rule.owner!.kind, value: DevScopeFx.MissingField } } : rule) }
        const { Fx } = await ScopeFx.With(model)
        const scope = await Fx.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P1))
        assert.equal(scope.Scope.Rows.has(SourceFx.Unknown), false)
        assert.deepEqual(await Fx.Column(DevScopeFx.P1, SourceFx.Widgets), [], 'missing owner field: User level denies')
        // the engine really validates: a scope naming what the schema lacks is refused
        const bad = AccessScope.Build({ Default: scope.Scope.Default, Hidden: new Map([[DevScopeFx.Widget, new Set([DevScopeFx.MissingField])]]) })
        await assert.rejects((await Fx.Engine()).BeginRead(bad), (error: unknown) => error instanceof GraphError && error.GraphCode === GraphErrorCode.InvalidArgument)
    })

    test('child Org under parent User sees all children on the engine (ConceptIs)', async () =>
    {
        const { Fx } = await ScopeFx.With(DevScopeFx.Model([SourceFx.ReadUser, DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.Organization, DevScopeFx.Gizmo)]))
        assert.deepEqual(await Fx.Column(DevScopeFx.P1, SourceFx.Gizmos), ['z1'], 'z1 is owned by p2 in root: only its own Org level admits it')
        assert.deepEqual(await Fx.Column(DevScopeFx.P1, SourceFx.Widgets), ['w1', 'z1'])
    })

    test('a field secured on the parent is readable and writable on a child that does not secure it (R94)', async () =>
    {
        const privileges = [SourceFx.ReadOrg, DevScopeFx.Privilege(PrivilegeAction.Read, AccessLevel.Organization, DevScopeFx.Gizmo), DevScopeFx.Privilege(PrivilegeAction.Update, AccessLevel.Organization, DevScopeFx.Gizmo)]
        const fields = DevScopeFx.Fields([DevScopeFx.Secret, DevScopeFx.Code], [{ field: DevScopeFx.Code, read: true }])
        const { Fx } = await ScopeFx.With(DevScopeFx.Model(privileges, fields))
        assert.deepEqual(await Fx.Column(DevScopeFx.P1, SourceFx.Secrets), ['z', null, null, null], 'read on the Gizmo, hidden on the Widgets (nulls sort last)')
        await Fx.Write(DevScopeFx.P1, SourceFx.SetGizmoCode)
        assert.deepEqual(await Fx.Column(DevScopeFx.P1, SourceFx.Gizmos), ['z1x'], 'read-only on Widget, writable on Gizmo')
    })

    test('a create-only field is settable on create and refused on update', async () =>
    {
        const writes = [SourceFx.ReadOrg, DevScopeFx.Privilege(PrivilegeAction.Create, AccessLevel.Organization), DevScopeFx.Privilege(PrivilegeAction.Update, AccessLevel.Organization)]
        const { Fx } = await ScopeFx.With(DevScopeFx.Model(writes, DevScopeFx.Fields([DevScopeFx.Owner], [{ field: DevScopeFx.Owner, read: true, create: true }])))
        await Fx.Write(DevScopeFx.P1, SourceFx.CreateOwned)
        await assert.rejects(Fx.Write(DevScopeFx.P1, SourceFx.SetOwner), SourceFx.Denied)
    })

    test('a hidden member is not writable even when its profile grants the write (write-only is unsupported)', async () =>
    {
        const writes = [SourceFx.ReadOrg, DevScopeFx.Privilege(PrivilegeAction.Update, AccessLevel.Organization)]
        const { Fx } = await ScopeFx.With(DevScopeFx.Model(writes, DevScopeFx.Fields([DevScopeFx.Secret], [{ field: DevScopeFx.Secret, update: true, create: true }])))
        await assert.rejects(Fx.Write(DevScopeFx.P1, SourceFx.SetSecret), (error: unknown) => SourceFx.Denied(error) && (error as Error).cause instanceof AccessError && ((error as Error).cause as AccessError).Code === AccessErrorCode.HiddenMember)
    })

    test('digest changes after Invalidate and differs for different claims', async () =>
    {
        const { Fx, Auth } = await ScopeFx.With(DevScopeFx.Model([SourceFx.ReadUser]))
        const before = await Fx.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P1))
        const claimed = await Fx.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P1, new Map([['dept', 'x']])))
        assert.notEqual(claimed.Digest, before.Digest)
        assert.ok(!claimed.Digest.includes('dept') && !claimed.Digest.includes('"x"'), 'claims are hashed, never carried')
        Auth.Invalidate(DevScopeFx.TenantId)
        assert.notEqual((await Fx.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P1))).Digest, before.Digest)
    })

    test('compiler diagnostics are reported once', async () =>
    {
        const base = DevScopeFx.Model([SourceFx.ReadUser])
        const model = { ...base, ownershipRules: base.ownershipRules.map(rule => rule.concept === DevScopeFx.Widget ? { ...rule, owner: { kind: rule.owner!.kind, value: DevScopeFx.MissingField } } : rule) }
        const { Fx } = await ScopeFx.With(model)
        await Fx.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P1))
        await Fx.Scopes.ScopeFor(DevScopeFx.Context(DevScopeFx.P2))
        assert.equal(Fx.Diagnostics.Messages.filter(message => message.startsWith('owner field "' + DevScopeFx.MissingField + '"')).length, 1, JSON.stringify(Fx.Diagnostics.Messages))
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
