import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newDb } from 'pg-mem'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import { compilePackage, BlobPackageStore, StoragePackageSink, Cypher } from '@pragmatic-tech-ai/todl'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import { AppWriteOpKind, AppWriteStatus } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AppWriteOpDto, AppWriteResultDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { PragmaticServer } from '../../pragmatic-server.js'
import { TenantPurpose } from '../../tenancy/tenant-purpose.js'
import { BuiltinStoreEngine } from '../connectors/builtin-store-engine.js'

class WriteFixture
{
    private static readonly Id = 'shop'
    private static readonly Version = '1.0.0'
    public static readonly AppName = 'demo'
    private static readonly SourceUri = 'shop.todl'
    public static readonly Widget = 'shop.Widget'
    public static readonly Gadget = 'shop.Gadget'
    public static readonly WidgetLabels = 'MATCH (w:Widget) RETURN w.label AS label'
    private static readonly CreateGadget = 'CREATE TABLE "Gadget" (gadget_id text PRIMARY KEY, label text)'
    private static readonly Todl = `
namespace shop {
  concept Widget { label : string; }
  concept Gadget { label : string; }
  datasource pg { kind = sql; database = "app"; }
  model Shop : shop {
    annotate entrypoint { }
    connect pg;
    populate Gadget key gadget_id { label = "label"; read-only; }
    Widget w0 { label = "seed-W"; }
  }
}
`
    private readonly packages = mkdtempSync(join(tmpdir(), 'adw2-pkgs-'))
    private readonly apps = mkdtempSync(join(tmpdir(), 'adw2-apps-'))
    private readonly db = newDb()
    private server: PragmaticServer | undefined

    public async Setup(): Promise<void>
    {
        this.db.public.none(WriteFixture.CreateGadget)
        const outcome = compilePackage([], [{ uri: WriteFixture.SourceUri, text: WriteFixture.Todl }], { id: WriteFixture.Id, version: WriteFixture.Version })
        assert.ok(outcome.ok, JSON.stringify(outcome.errors))
        await new BlobPackageStore(new StoragePackageSink(new NodeFsStorage(this.packages))).persist(outcome.package!)
        mkdirSync(join(this.apps, WriteFixture.AppName))
        writeFileSync(join(this.apps, WriteFixture.AppName, 'application.json'), JSON.stringify({ name: WriteFixture.AppName, version: WriteFixture.Version, packages: [{ id: WriteFixture.Id, version: WriteFixture.Version }] }))
        this.server = new PragmaticServer({
            packagesRoot: this.packages, applicationsRoot: this.apps, purpose: TenantPurpose.Runtime,
            builtinStoreEngine: BuiltinStoreEngine.Document,
            connectors: { buildPool: () => new (this.db.adapters.createPg()).Pool() as never },
        })
        await this.server.Start()
    }

    private static Context(): AccessContext
    {
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'T')
        const principal = new Principal('p1', 't1', PrincipalKind.User, new Map(), [])
        const grants = [new Grant('p1', Role.Owner, new ResourceRef(ResourceKind.Tenant, 't1', []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    public Write(ops: AppWriteOpDto[]): Promise<AppWriteResultDto>
    {
        return this.server!.WriteForPragmaticApp(WriteFixture.Context(), WriteFixture.AppName, ops)
    }

    public async Labels(): Promise<string[]>
    {
        const graph = await this.server!.GraphForPragmaticApp(WriteFixture.Context(), WriteFixture.AppName, Cypher.ReferencedLabels.Of(WriteFixture.WidgetLabels))
        return Cypher.CypherEngine.OverQuery(graph).Execute(WriteFixture.WidgetLabels).Rows
            .map(r => (r[0] instanceof Cypher.ScalarValue ? String(r[0].Value) : '')).sort()
    }

    public async Dispose(): Promise<void>
    {
        await this.server?.Dispose()
        rmSync(this.packages, { recursive: true, force: true })
        rmSync(this.apps, { recursive: true, force: true })
    }
}

class Case
{
    public static async Run(body: (fx: WriteFixture) => Promise<void>): Promise<void>
    {
        const fx = new WriteFixture()
        try
        {
            await fx.Setup()
            await body(fx)
        }
        finally
        {
            await fx.Dispose()
        }
    }
}

test('create on the built-in store mints an id and is readable', async () =>
{
    await Case.Run(async fx =>
    {
        const out = await fx.Write([{ op: AppWriteOpKind.Create, concept: WriteFixture.Widget, fields: { label: 'new-W' } }])
        assert.equal(out.results[0].status, AppWriteStatus.Applied)
        assert.ok(out.results[0].id && out.results[0].id.length > 0)
        assert.deepEqual(await fx.Labels(), ['new-W', 'seed-W'])
    })
})

test('update replaces a built-in record', async () =>
{
    await Case.Run(async fx =>
    {
        const created = await fx.Write([{ op: AppWriteOpKind.Create, concept: WriteFixture.Widget, fields: { label: 'v1' } }])
        const id = created.results[0].id as string
        await fx.Write([{ op: AppWriteOpKind.Update, concept: WriteFixture.Widget, id, fields: { label: 'v2' } }])
        assert.deepEqual(await fx.Labels(), ['seed-W', 'v2'])
    })
})

test('delete removes a built-in record', async () =>
{
    await Case.Run(async fx =>
    {
        const created = await fx.Write([{ op: AppWriteOpKind.Create, concept: WriteFixture.Widget, fields: { label: 'gone' } }])
        const id = created.results[0].id as string
        await fx.Write([{ op: AppWriteOpKind.Delete, concept: WriteFixture.Widget, id }])
        assert.deepEqual(await fx.Labels(), ['seed-W'])
    })
})

test('a write to a read-only external (populate) binding is denied', async () =>
{
    await Case.Run(async fx =>
    {
        const out = await fx.Write([{ op: AppWriteOpKind.Update, concept: WriteFixture.Gadget, id: 'g1', fields: { label: 'x' } }])
        assert.equal(out.results[0].status, AppWriteStatus.Denied)
    })
})

test('a batch of two creates both apply in input order', async () =>
{
    await Case.Run(async fx =>
    {
        const out = await fx.Write([
            { op: AppWriteOpKind.Create, concept: WriteFixture.Widget, fields: { label: 'a' } },
            { op: AppWriteOpKind.Create, concept: WriteFixture.Widget, fields: { label: 'b' } },
        ])
        assert.equal(out.results[0].status, AppWriteStatus.Applied)
        assert.equal(out.results[1].status, AppWriteStatus.Applied)
        assert.deepEqual(await fx.Labels(), ['a', 'b', 'seed-W'])
    })
})
