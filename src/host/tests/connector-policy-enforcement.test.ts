import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newDb } from 'pg-mem'
import { DataSourceKind } from '@pragmatic-tech-ai/todl'
import { PragmaticServer } from '../../pragmatic-server.js'
import { ConnectorsPolicy } from '../connector-policy.js'

class Fixture
{
    private static readonly DirPrefix = 'ph6c-'
    private static readonly SolutionFile = 'Sample.pksln'
    private static readonly ModelsDir = 'models'
    private static readonly ProjectFile = 'project.plexus'
    private static readonly ModelFile = 'model.todl'
    private static readonly PackagesDir = 'packages'
    private static readonly ConceptId = 'shop.Customer'
    private static readonly CreateTable = 'CREATE TABLE "Customer" (customer_id text PRIMARY KEY, name text, description text, label text)'
    private static readonly InsertRow = `INSERT INTO "Customer" (customer_id, name) VALUES ('C1', 'Acme')`
    private static readonly ModelTodl = `
namespace shop {
  concept Customer { name : string; }
  datasource pg { kind = sql; database = "app"; }
  model Shop : shop {
    annotate entrypoint { }
    connect pg;
    populate Customer key customer_id { name = "name"; }
  }
}
`

    private static SolutionDir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), Fixture.DirPrefix))
        writeFileSync(join(dir, Fixture.SolutionFile), JSON.stringify({ kind: 'todl-solution', version: 1, name: 'Sample', members: [{ path: Fixture.ModelsDir, type: 'meta-model' }], settings: {}, bags: {} }))
        mkdirSync(join(dir, Fixture.ModelsDir), { recursive: true })
        writeFileSync(join(dir, Fixture.ModelsDir, Fixture.ProjectFile), JSON.stringify({ type: 'meta-model', name: 'Shop Model', id: 'shop-model', packageVersion: '0.1.0' }))
        writeFileSync(join(dir, Fixture.ModelsDir, Fixture.ModelFile), Fixture.ModelTodl)
        return dir
    }

    private static Pool(): unknown
    {
        const db = newDb()
        db.public.none(Fixture.CreateTable)
        db.public.none(Fixture.InsertRow)
        return new (db.adapters.createPg()).Pool()
    }

    /** Opens the fixture solution under the given policy and runs the body against the connector runtime. */
    public static async WithServer(policy: ConnectorsPolicy, body: (read: () => Promise<readonly unknown[]>) => Promise<void>): Promise<void>
    {
        const dir = Fixture.SolutionDir()
        const pool = Fixture.Pool()
        const server = new PragmaticServer({ packagesRoot: join(dir, Fixture.PackagesDir), connectors: { buildPool: () => pool as never }, connectorsPolicy: policy })
        try
        {
            await server.Start()
            await server.OpenSolution(dir)
            const runtime = await server.Connectors()
            const models = runtime.ModelsWithConnectors()
            await body(async () => (await runtime.ReadEntities(models[0]!.ModelId, Fixture.ConceptId)).Entities)
        }
        finally
        {
            await server.Dispose()
            rmSync(dir, { recursive: true, force: true })
        }
    }
}

test('a catalog-only tenant rejects an inline-datasource connector', async () =>
{
    await Fixture.WithServer(new ConnectorsPolicy([DataSourceKind.Sql], true, false, []), async read =>
    {
        await assert.rejects(() => read(), /catalog-only/)
    })
})

test('a permissive tenant reads the same inline-datasource connector', async () =>
{
    await Fixture.WithServer(ConnectorsPolicy.Default(), async read =>
    {
        const entities = await read()
        assert.ok(entities.length >= 1)
    })
})

test('a tenant whose allowlist omits Sql cannot read a SQL connector', async () =>
{
    await Fixture.WithServer(new ConnectorsPolicy([DataSourceKind.Rest], false, false, []), async read =>
    {
        await assert.rejects(() => read(), /adapter-not-allowed/)
    })
})
