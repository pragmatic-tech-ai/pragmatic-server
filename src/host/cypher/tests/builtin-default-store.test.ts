import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newDb } from 'pg-mem'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import { compilePackage, BlobPackageStore, StoragePackageSink, Cypher, DataSourceKind, WriteOperationKind, PolicyNodeKind, PolicyRefRoot, PolicyCompareOp } from '@pragmatic-tech-ai/todl'
import type { IDataSourceAdapter, ExternalFieldValue } from '@pragmatic-tech-ai/todl'
import type { IGraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticServer } from '../../../pragmatic-server.js'
import { TenantPurpose } from '../../../tenancy/tenant-purpose.js'
import { NodePlatform } from '../../../platform/node-platform.js'
import { AccessPolicySetting } from '../../apps/access-policy-setting.js'
import { BuiltinAdapterFactory } from '../../connectors/builtin-adapter-factory.js'
import { BuiltinBindings } from '../../connectors/builtin-bindings.js'
import { BuiltinStoreEngine } from '../../connectors/builtin-store-engine.js'
import { PpSecurityHarness } from './pp-security-harness.js'

class BuiltinFixture
{
    private static readonly Id = 'shop'
    private static readonly Version = '1.0.0'
    private static readonly AppName = 'demo'
    private static readonly ManifestFile = 'application.json'
    private static readonly DataDir = 'data'
    private static readonly PkgPrefix = 'bds-pkgs-'
    private static readonly AppsPrefix = 'bds-apps-'
    private static readonly IdPrefix = 'bds-id-'
    private static readonly SourceUri = 'shop.todl'
    private static readonly Principal = 'p1'
    private static readonly Deny = 'deny'
    private static readonly Read = 'read'
    public static readonly LabelField = 'label'
    private static readonly OwningBuField = 'owningBu'
    private static readonly IdKey = 'id'
    private static readonly CreateGadget = 'CREATE TABLE "Gadget" (gadget_id text PRIMARY KEY, label text, description text)'
    private static readonly SeedGadget = `INSERT INTO "Gadget" (gadget_id, label) VALUES ('g1', 'ext-G1')`
    public static readonly WidgetConcept = 'shop.Widget'
    public static readonly GadgetConcept = 'shop.Gadget'
    public static readonly WithConnector = `
namespace shop {
  concept Widget { owningBu : string; label : string; }
  concept Gadget { label : string; }
  datasource pg { kind = sql; database = "app"; }
  model Shop : shop {
    annotate entrypoint { }
    connect pg;
    populate Gadget key gadget_id { label = "label"; }
    Widget w0 { owningBu = "sales"; label = "seed-W"; }
    Gadget g0 { label = "seed-G"; }
  }
}
`
    public static readonly NoConnector = `
namespace shop {
  concept Widget { owningBu : string; label : string; }
  model Shop : shop {
    annotate entrypoint { }
    Widget w0 { owningBu = "sales"; label = "seed-W"; }
  }
}
`
    public static readonly WidgetLabels = 'MATCH (w:Widget) RETURN w.label AS label'
    public static readonly GadgetLabels = 'MATCH (g:Gadget) RETURN g.label AS label'
    public static readonly Wildcard = 'MATCH (n) RETURN n.label AS label'

    private readonly packages = mkdtempSync(join(tmpdir(), BuiltinFixture.PkgPrefix))
    private readonly apps = mkdtempSync(join(tmpdir(), BuiltinFixture.AppsPrefix))
    private readonly identityRoot = mkdtempSync(join(tmpdir(), BuiltinFixture.IdPrefix))
    private readonly db = newDb()
    private server: PragmaticServer | undefined
    private secured = false
    private store: IDataSourceAdapter | undefined

    public async Setup(todl: string, model?: ISecurityModelConfig): Promise<PragmaticServer>
    {
        this.db.public.none(BuiltinFixture.CreateGadget)
        this.db.public.none(BuiltinFixture.SeedGadget)
        const outcome = compilePackage([], [{ uri: BuiltinFixture.SourceUri, text: todl }], { id: BuiltinFixture.Id, version: BuiltinFixture.Version })
        assert.ok(outcome.ok, JSON.stringify(outcome.errors))
        await new BlobPackageStore(new StoragePackageSink(new NodeFsStorage(this.packages))).persist(outcome.package!)
        mkdirSync(join(this.apps, BuiltinFixture.AppName))
        writeFileSync(join(this.apps, BuiltinFixture.AppName, BuiltinFixture.ManifestFile), JSON.stringify({
            name: BuiltinFixture.AppName, version: BuiltinFixture.Version,
            packages: [{ id: BuiltinFixture.Id, version: BuiltinFixture.Version }],
        }))
        this.secured = model !== undefined
        if (this.secured)
        {
            PpSecurityHarness.SetKey()
        }
        this.server = new PragmaticServer({
            packagesRoot: this.packages, applicationsRoot: this.apps, purpose: TenantPurpose.Runtime,
            builtinStoreEngine: BuiltinStoreEngine.Document,
            connectors: { buildPool: () => new (this.db.adapters.createPg()).Pool() as never },
            identity: this.secured ? PpSecurityHarness.Identity(this.identityRoot) : undefined,
        })
        await this.server.Start()
        if (model !== undefined)
        {
            await PpSecurityHarness.Seed(this.server, model)
        }
        return this.server
    }

    /** Writes a row into the app's built-in store via the built-in adapter over the same per-app data root the server routes to. */
    public async Put(concept: string, key: string, fields: Record<string, ExternalFieldValue>): Promise<void>
    {
        const result = await (await this.Store()).Apply({
            Source: BuiltinBindings.CollectionFor(concept), IdKey: BuiltinFixture.IdKey,
            Operations: [{ Kind: WriteOperationKind.Upsert, Key: key, Fields: fields }],
        })
        assert.equal(result.Applied, 1)
    }

    public async Remove(concept: string, key: string): Promise<void>
    {
        const result = await (await this.Store()).Apply({
            Source: BuiltinBindings.CollectionFor(concept), IdKey: BuiltinFixture.IdKey,
            Operations: [{ Kind: WriteOperationKind.Delete, Key: key, Fields: {} }],
        })
        assert.equal(result.Applied, 1)
    }

    public static Widget(label: string, owningBu?: string): Record<string, ExternalFieldValue>
    {
        return owningBu === undefined ? { [BuiltinFixture.LabelField]: label } : { [BuiltinFixture.LabelField]: label, [BuiltinFixture.OwningBuField]: owningBu }
    }

    public static Bu(): ISecurityModelConfig
    {
        return BuiltinFixture.Retarget(PpSecurityHarness.BuSecurityModel(BuiltinFixture.Principal))
    }

    public static Org(): ISecurityModelConfig
    {
        return BuiltinFixture.Retarget(PpSecurityHarness.OrgSecurityModel(BuiltinFixture.Principal))
    }

    public DenyLabel(label: string): void
    {
        const rules = [{
            effect: BuiltinFixture.Deny, action: BuiltinFixture.Read,
            predicate: {
                kind: PolicyNodeKind.Compare, op: PolicyCompareOp.Eq,
                left: { kind: PolicyNodeKind.Ref, root: PolicyRefRoot.Entity, member: BuiltinFixture.LabelField },
                right: { kind: PolicyNodeKind.Literal, value: label },
            },
        }]
        writeFileSync(join(this.apps, BuiltinFixture.AppName, AccessPolicySetting.PolicyFile), JSON.stringify({ [BuiltinFixture.WidgetConcept]: rules }))
    }

    public static async Labels(server: PragmaticServer, query: string): Promise<string[]>
    {
        const graph = await server.GraphForPragmaticApp(PpSecurityHarness.Context(BuiltinFixture.Principal), BuiltinFixture.AppName, Cypher.ReferencedLabels.Of(query))
        return BuiltinFixture.Column(graph, query)
    }

    public async Dispose(): Promise<void>
    {
        await this.store?.Dispose()
        await this.server?.Dispose()
        rmSync(this.packages, { recursive: true, force: true })
        rmSync(this.apps, { recursive: true, force: true })
        rmSync(this.identityRoot, { recursive: true, force: true })
        if (this.secured)
        {
            PpSecurityHarness.ClearKey()
        }
    }

    private async Store(): Promise<IDataSourceAdapter>
    {
        if (this.store === undefined)
        {
            const factory = new BuiltinAdapterFactory((root, engine) => new NodePlatform().CreateAppDataStore(root, engine))
            this.store = await factory.Open({
                Kind: DataSourceKind.Builtin,
                Config: {
                    [BuiltinAdapterFactory.DataRootKey]: join(this.apps, BuiltinFixture.AppName, BuiltinFixture.DataDir),
                    [BuiltinAdapterFactory.EngineKey]: BuiltinStoreEngine.Document,
                },
            })
        }
        return this.store
    }

    /** The harness models target concept `Widget`; retarget them at the namespaced `shop.Widget`. */
    private static Retarget(model: ISecurityModelConfig): ISecurityModelConfig
    {
        const target = (concept: string) => concept === PpSecurityHarness.Concept ? BuiltinFixture.WidgetConcept : concept
        return {
            ...model,
            ownershipRules: model.ownershipRules.map(r => ({ ...r, concept: target(r.concept) })),
            roles: model.roles?.map(r => ({ ...r, privileges: r.privileges.map(p => ({ ...p, concept: target(p.concept) })) })),
        }
    }

    private static Column(graph: IGraphQuery, query: string): string[]
    {
        return Cypher.CypherEngine.OverQuery(graph).Execute(query).Rows
            .map(r => (r[0] instanceof Cypher.ScalarValue ? String(r[0].Value) : '')).sort()
    }
}

class Case
{
    public static async Run(todl: string, model: ISecurityModelConfig | undefined, body: (fx: BuiltinFixture, server: PragmaticServer) => Promise<void>): Promise<void>
    {
        const fx = new BuiltinFixture()
        try
        {
            await body(fx, await fx.Setup(todl, model))
        }
        finally
        {
            await fx.Dispose()
        }
    }
}

test('implicit routing + union: a no-populate concept returns package seed plus built-in store rows, never double-counted', async () =>
{
    await Case.Run(BuiltinFixture.WithConnector, undefined, async (fx, server) =>
    {
        assert.deepEqual(await BuiltinFixture.Labels(server, BuiltinFixture.WidgetLabels), ['seed-W'])
        await fx.Put(BuiltinFixture.WidgetConcept, 's1', BuiltinFixture.Widget('store-1', 'sales'))
        assert.deepEqual(await BuiltinFixture.Labels(server, BuiltinFixture.WidgetLabels), ['seed-W', 'store-1'])
        assert.deepEqual(await BuiltinFixture.Labels(server, BuiltinFixture.WidgetLabels), ['seed-W', 'store-1'], 'a repeat query does not duplicate')
        await fx.Remove(BuiltinFixture.WidgetConcept, 's1')
        assert.deepEqual(await BuiltinFixture.Labels(server, BuiltinFixture.WidgetLabels), ['seed-W'])
    })
})

test('external still shadows: an explicit populate concept returns adapter rows only, with no seed leak and no store rows', async () =>
{
    await Case.Run(BuiltinFixture.WithConnector, undefined, async (fx, server) =>
    {
        await fx.Put(BuiltinFixture.GadgetConcept, 'x1', { [BuiltinFixture.LabelField]: 'store-G' })
        assert.deepEqual(await BuiltinFixture.Labels(server, BuiltinFixture.GadgetLabels), ['ext-G1'])
    })
})

test('no-connector app: an empty store yields exactly the package seed', async () =>
{
    await Case.Run(BuiltinFixture.NoConnector, undefined, async (_fx, server) =>
    {
        assert.deepEqual(await BuiltinFixture.Labels(server, BuiltinFixture.WidgetLabels), ['seed-W'])
    })
})

test('freshness: each query reflects the latest store writes on the same cached server', async () =>
{
    await Case.Run(BuiltinFixture.NoConnector, undefined, async (fx, server) =>
    {
        await fx.Put(BuiltinFixture.WidgetConcept, 'a', BuiltinFixture.Widget('one'))
        assert.deepEqual(await BuiltinFixture.Labels(server, BuiltinFixture.WidgetLabels), ['one', 'seed-W'])
        await fx.Put(BuiltinFixture.WidgetConcept, 'b', BuiltinFixture.Widget('two'))
        assert.deepEqual(await BuiltinFixture.Labels(server, BuiltinFixture.WidgetLabels), ['one', 'seed-W', 'two'])
    })
})

test('wildcard: an unlabeled node pattern includes built-in store rows', async () =>
{
    await Case.Run(BuiltinFixture.NoConnector, undefined, async (fx, server) =>
    {
        await fx.Put(BuiltinFixture.WidgetConcept, 'a', BuiltinFixture.Widget('wild'))
        const labels = await BuiltinFixture.Labels(server, BuiltinFixture.Wildcard)
        assert.ok(labels.includes('wild') && labels.includes('seed-W'), labels.join(','))
    })
})

test('SP-3b compose: the BusinessUnit depth filter hides a built-in store instance owned outside the principal BU', async () =>
{
    await Case.Run(BuiltinFixture.NoConnector, BuiltinFixture.Bu(), async (fx, server) =>
    {
        await fx.Put(BuiltinFixture.WidgetConcept, 's1', BuiltinFixture.Widget('store-sales', 'sales'))
        await fx.Put(BuiltinFixture.WidgetConcept, 'r1', BuiltinFixture.Widget('store-root', 'root'))
        assert.deepEqual(await BuiltinFixture.Labels(server, BuiltinFixture.WidgetLabels), ['seed-W', 'store-sales'])
    })
})

test('SP-3b compose: a predicate deny drops a built-in store instance the depth axis allows', async () =>
{
    await Case.Run(BuiltinFixture.NoConnector, BuiltinFixture.Org(), async (fx, server) =>
    {
        await fx.Put(BuiltinFixture.WidgetConcept, 's1', BuiltinFixture.Widget('store-1', 'sales'))
        await fx.Put(BuiltinFixture.WidgetConcept, 'r1', BuiltinFixture.Widget('store-2', 'root'))
        assert.deepEqual(await BuiltinFixture.Labels(server, BuiltinFixture.WidgetLabels), ['seed-W', 'store-1', 'store-2'])
        fx.DenyLabel('store-1')
        assert.deepEqual(await BuiltinFixture.Labels(server, BuiltinFixture.WidgetLabels), ['seed-W', 'store-2'])
    })
})
