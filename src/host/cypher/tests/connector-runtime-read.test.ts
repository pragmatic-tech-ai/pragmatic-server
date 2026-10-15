import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newDb } from 'pg-mem'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import { compilePackage, BlobPackageStore, StoragePackageSink, Cypher, PolicyNodeKind, PolicyRefRoot, PolicyCompareOp } from '@pragmatic-tech-ai/todl'
import type { IGraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticServer } from '../../../pragmatic-server.js'
import type { ReferencedLabelSet } from '../../../pragmatic-server.js'
import { TenantPurpose } from '../../../tenancy/tenant-purpose.js'
import { AccessPolicySetting } from '../../apps/access-policy-setting.js'
import { CypherParamConverter } from '../cypher-param-converter.js'
import { PpSecurityHarness } from './pp-security-harness.js'

class ConnectorReadFixture
{
    private static readonly Id = 'shop'
    private static readonly Version = '1.0.0'
    private static readonly AppName = 'demo'
    private static readonly ManifestFile = 'application.json'
    private static readonly PkgPrefix = 'crr-pkgs-'
    private static readonly AppsPrefix = 'crr-apps-'
    private static readonly IdPrefix = 'crr-id-'
    private static readonly SourceUri = 'shop.todl'
    private static readonly BrokenDatabase = 'broken'
    private static readonly Principal = 'p1'
    private static readonly Deny = 'deny'
    private static readonly Read = 'read'
    private static readonly LabelField = 'label'
    private static readonly WidgetConcept = 'shop.Widget'
    private static readonly PoolError = 'no such database'
    private static readonly CreateWidget = 'CREATE TABLE "Widget" (widget_id text PRIMARY KEY, owning_bu text, label text, description text)'
    private static readonly CreateGadget = 'CREATE TABLE "Gadget" (gadget_id text PRIMARY KEY, label text, description text)'
    private static readonly SeedWidgets = `INSERT INTO "Widget" (widget_id, owning_bu, label) VALUES ('w1', 'sales', 'S1'), ('w2', 'sales', 'S2'), ('w3', 'root', 'R1')`
    private static readonly SeedGadget = `INSERT INTO "Gadget" (gadget_id, label) VALUES ('g1', 'G1')`
    private static readonly UpdateWidget = `UPDATE "Widget" SET label = 'S1-changed' WHERE widget_id = 'w1'`
    private static readonly Todl = `
namespace shop {
  concept Widget { owningBu : string; label : string; }
  concept Gadget { label : string; }
  concept Note { label : string; relationship link -> Widget?; relationship peer -> Note?; }
  datasource pg { kind = sql; database = "app"; }
  datasource bad { kind = sql; database = "broken"; }
  model Shop : shop {
    annotate entrypoint { }
    connect pg;
    connect bad;
    populate Widget key widget_id { owningBu = "owning_bu"; label = "label"; }
    populate Gadget from bad key gadget_id { label = "label"; }
    Note n1 { label = "native-1"; }
    Note n2 { label = "native-2"; peer = n1; }
  }
}
`
    public static readonly WidgetLabels = 'MATCH (w:Widget) RETURN w.label AS label'
    public static readonly WhereQuery = 'MATCH (w:Widget) WHERE w.label = $v RETURN w.label AS label'
    public static readonly GadgetLabels = 'MATCH (g:Gadget) RETURN g.label AS label'
    public static readonly NoteLabels = 'MATCH (n:Note) RETURN n.label AS label'
    public static readonly Wildcard = 'MATCH (n) RETURN n.label AS label'
    public static readonly NativeEdge = 'MATCH (a:Note)-[:peer]->(b:Note) RETURN a.label AS label'
    public static readonly EdgeToConnector = 'MATCH (n:Note)-[:link]->(w:Widget) RETURN n.label AS label'
    public static readonly EdgeFromConnector = 'MATCH (w:Widget)<-[:link]-(n:Note) RETURN w.label AS label'

    private readonly packages = mkdtempSync(join(tmpdir(), ConnectorReadFixture.PkgPrefix))
    private readonly apps = mkdtempSync(join(tmpdir(), ConnectorReadFixture.AppsPrefix))
    private readonly identityRoot = mkdtempSync(join(tmpdir(), ConnectorReadFixture.IdPrefix))
    private readonly db = newDb()
    private server: PragmaticServer | undefined
    private secured = false

    /** Boots a runtime server over a pg-mem backed connector; `model` undefined means no identity (allow-all depth). */
    public async Setup(model?: ISecurityModelConfig): Promise<PragmaticServer>
    {
        this.db.public.none(ConnectorReadFixture.CreateWidget)
        this.db.public.none(ConnectorReadFixture.CreateGadget)
        this.db.public.none(ConnectorReadFixture.SeedWidgets)
        this.db.public.none(ConnectorReadFixture.SeedGadget)
        const outcome = compilePackage([], [{ uri: ConnectorReadFixture.SourceUri, text: ConnectorReadFixture.Todl }], { id: ConnectorReadFixture.Id, version: ConnectorReadFixture.Version })
        assert.ok(outcome.ok, JSON.stringify(outcome.errors))
        await new BlobPackageStore(new StoragePackageSink(new NodeFsStorage(this.packages))).persist(outcome.package!)
        mkdirSync(join(this.apps, ConnectorReadFixture.AppName))
        writeFileSync(join(this.apps, ConnectorReadFixture.AppName, ConnectorReadFixture.ManifestFile), JSON.stringify({
            name: ConnectorReadFixture.AppName, version: ConnectorReadFixture.Version,
            packages: [{ id: ConnectorReadFixture.Id, version: ConnectorReadFixture.Version }],
        }))
        this.secured = model !== undefined
        if (this.secured)
        {
            PpSecurityHarness.SetKey()
        }
        this.server = new PragmaticServer({
            packagesRoot: this.packages, applicationsRoot: this.apps, purpose: TenantPurpose.Runtime,
            connectors: { buildPool: options => this.BuildPool(options.database) },
            identity: this.secured ? PpSecurityHarness.Identity(this.identityRoot) : undefined,
        })
        await this.server.Start()
        if (model !== undefined)
        {
            await PpSecurityHarness.Seed(this.server, model)
        }
        return this.server
    }

    public static Context()
    {
        return PpSecurityHarness.Context(ConnectorReadFixture.Principal)
    }

    public static get Name(): string
    {
        return ConnectorReadFixture.AppName
    }

    /** The harness models target concept `Widget`; retarget them at the connector-backed `shop.Widget`. */
    public static Bu(): ISecurityModelConfig
    {
        return ConnectorReadFixture.Retarget(PpSecurityHarness.BuSecurityModel(ConnectorReadFixture.Principal))
    }

    public static Org(): ISecurityModelConfig
    {
        return ConnectorReadFixture.Retarget(PpSecurityHarness.OrgSecurityModel(ConnectorReadFixture.Principal))
    }

    public MutateWidget(): void
    {
        this.db.public.none(ConnectorReadFixture.UpdateWidget)
    }

    public DenyLabel(label: string): void
    {
        const rules = [{
            effect: ConnectorReadFixture.Deny, action: ConnectorReadFixture.Read,
            predicate: {
                kind: PolicyNodeKind.Compare, op: PolicyCompareOp.Eq,
                left: { kind: PolicyNodeKind.Ref, root: PolicyRefRoot.Entity, member: ConnectorReadFixture.LabelField },
                right: { kind: PolicyNodeKind.Literal, value: label },
            },
        }]
        writeFileSync(join(this.apps, ConnectorReadFixture.AppName, AccessPolicySetting.PolicyFile), JSON.stringify({ [ConnectorReadFixture.WidgetConcept]: rules }))
    }

    public static async Labels(server: PragmaticServer, query: string, labels: ReferencedLabelSet, params?: { [k: string]: string }): Promise<string[]>
    {
        const graph = await server.GraphForPragmaticApp(ConnectorReadFixture.Context(), ConnectorReadFixture.AppName, labels)
        return ConnectorReadFixture.Column(graph, query, params)
    }

    public static Referenced(query: string): ReferencedLabelSet
    {
        return Cypher.ReferencedLabels.Of(query)
    }

    public async Dispose(): Promise<void>
    {
        await this.server?.Dispose()
        rmSync(this.packages, { recursive: true, force: true })
        rmSync(this.apps, { recursive: true, force: true })
        rmSync(this.identityRoot, { recursive: true, force: true })
        if (this.secured)
        {
            PpSecurityHarness.ClearKey()
        }
    }

    private BuildPool(database: string | undefined): never
    {
        if (database === ConnectorReadFixture.BrokenDatabase)
        {
            throw new Error(ConnectorReadFixture.PoolError)
        }
        return new (this.db.adapters.createPg()).Pool() as never
    }

    private static Retarget(model: ISecurityModelConfig): ISecurityModelConfig
    {
        const target = (concept: string) => concept === PpSecurityHarness.Concept ? ConnectorReadFixture.WidgetConcept : concept
        return {
            ...model,
            ownershipRules: model.ownershipRules.map(r => ({ ...r, concept: target(r.concept) })),
            roles: model.roles?.map(r => ({ ...r, privileges: r.privileges.map(p => ({ ...p, concept: target(p.concept) })) })),
        }
    }

    private static Column(graph: IGraphQuery, query: string, params?: { [k: string]: string }): string[]
    {
        return Cypher.CypherEngine.OverQuery(graph).Execute(query, CypherParamConverter.ToMap(params)).Rows
            .map(r => (r[0] instanceof Cypher.ScalarValue ? String(r[0].Value) : '')).sort()
    }
}

class Case
{
    public static async Run(model: ISecurityModelConfig | undefined, body: (fx: ConnectorReadFixture, server: PragmaticServer) => Promise<void>): Promise<void>
    {
        const fx = new ConnectorReadFixture()
        try
        {
            await body(fx, await fx.Setup(model))
        }
        finally
        {
            await fx.Dispose()
        }
    }

    public static Read(server: PragmaticServer, query: string, params?: { [k: string]: string }): Promise<string[]>
    {
        return ConnectorReadFixture.Labels(server, query, ConnectorReadFixture.Referenced(query), params)
    }
}

test('lazy read: a connector-backed concept returns the adapter rows', async () =>
{
    await Case.Run(undefined, async (_fx, server) =>
    {
        assert.deepEqual(await Case.Read(server, ConnectorReadFixture.WidgetLabels), ['R1', 'S1', 'S2'])
    })
})

test('in-memory WHERE: only matching connector rows are returned', async () =>
{
    await Case.Run(undefined, async (_fx, server) =>
    {
        assert.deepEqual(await Case.Read(server, ConnectorReadFixture.WhereQuery, { v: 'S2' }), ['S2'])
    })
})

test('freshness: a changed adapter row is visible to the next query', async () =>
{
    await Case.Run(undefined, async (fx, server) =>
    {
        assert.deepEqual(await Case.Read(server, ConnectorReadFixture.WidgetLabels), ['R1', 'S1', 'S2'])
        fx.MutateWidget()
        assert.deepEqual(await Case.Read(server, ConnectorReadFixture.WidgetLabels), ['R1', 'S1-changed', 'S2'])
    })
})

test('SP-3b compose: the BusinessUnit depth filter hides a connector-backed instance owned outside the principal BU', async () =>
{
    await Case.Run(ConnectorReadFixture.Bu(), async (_fx, server) =>
    {
        assert.deepEqual(await Case.Read(server, ConnectorReadFixture.WidgetLabels), ['S1', 'S2'])
    })
})

test('SP-3b compose: a predicate deny drops a connector-backed instance the depth axis allows', async () =>
{
    await Case.Run(ConnectorReadFixture.Org(), async (fx, server) =>
    {
        assert.deepEqual(await Case.Read(server, ConnectorReadFixture.WidgetLabels), ['R1', 'S1', 'S2'])
        fx.DenyLabel('S1')
        assert.deepEqual(await Case.Read(server, ConnectorReadFixture.WidgetLabels), ['R1', 'S2'])
    })
})

test('wildcard: an unlabeled node pattern prefetches every connector concept', async () =>
{
    await Case.Run(undefined, async (_fx, server) =>
    {
        const labels = await Case.Read(server, ConnectorReadFixture.Wildcard)
        for (const expected of ['R1', 'S1', 'S2', 'native-1', 'native-2'])
        {
            assert.ok(labels.includes(expected), `${expected} present in ${labels.join(',')}`)
        }
        assert.ok(!labels.includes('G1'), 'the unresolved-adapter concept contributes nothing')
    })
})

test('wildcard + SecurityModel: the depth filter hides a connector-backed instance on the AllInstances path', async () =>
{
    await Case.Run(ConnectorReadFixture.Bu(), async (_fx, server) =>
    {
        const labels = await Case.Read(server, ConnectorReadFixture.Wildcard)
        assert.ok(labels.includes('S1') && labels.includes('S2'), `visible widgets present in ${labels.join(',')}`)
        assert.ok(!labels.includes('R1'), 'the root-owned connector row is hidden under the wildcard path')
    })
})

test('an unparseable query prefetches nothing and surfaces the engine syntax error', async () =>
{
    await Case.Run(undefined, async (_fx, server) =>
    {
        await assert.rejects(Case.Read(server, 'MATCH (w:Widget RETURN'))
    })
})

test('native concepts read unchanged and without a connector prefetch', async () =>
{
    await Case.Run(undefined, async (_fx, server) =>
    {
        assert.deepEqual(await Case.Read(server, ConnectorReadFixture.NoteLabels), ['native-1', 'native-2'])
        assert.deepEqual(await Case.Read(server, ConnectorReadFixture.NativeEdge), ['native-2'])
    })
})

test('deferred edges: relationships to or from a connector-backed instance are empty', async () =>
{
    await Case.Run(undefined, async (_fx, server) =>
    {
        assert.deepEqual(await Case.Read(server, ConnectorReadFixture.EdgeToConnector), [])
        assert.deepEqual(await Case.Read(server, ConnectorReadFixture.EdgeFromConnector), [])
    })
})

test('fail-closed: a concept whose adapter cannot be resolved is empty while other concepts still read', async () =>
{
    await Case.Run(undefined, async (_fx, server) =>
    {
        assert.deepEqual(await Case.Read(server, ConnectorReadFixture.GadgetLabels), [])
        assert.deepEqual(await Case.Read(server, ConnectorReadFixture.WidgetLabels), ['R1', 'S1', 'S2'])
    })
})
