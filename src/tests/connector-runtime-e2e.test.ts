import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newDb } from 'pg-mem'
import { PragmaticServer } from '../pragmatic-server.js'

/** Builds on-disk solution fixtures (exact schema of src/tests/fixtures/sample-solution) + a pg-mem pool.
 *  The connector model.todl is anchored on TODL/src/codegen/tests/connector-package-fixture.test.ts. */
class Phase6aGolden
{
    public static readonly ConnectorModelTodl = `
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
    public static readonly PlainModelTodl = 'namespace acme { concept Widget { label : string?; } }'

    private static WriteSolution(dir: string, modelTodl: string): void
    {
        writeFileSync(join(dir, 'Sample.pksln'), JSON.stringify({ kind: 'todl-solution', version: 1, name: 'Sample', members: [{ path: 'models', type: 'meta-model' }], settings: {}, bags: {} }))
        mkdirSync(join(dir, 'models'), { recursive: true })
        writeFileSync(join(dir, 'models', 'project.plexus'), JSON.stringify({ type: 'meta-model', name: 'Shop Model', id: 'shop-model', packageVersion: '0.1.0' }))
        writeFileSync(join(dir, 'models', 'model.todl'), modelTodl)
    }

    public static ConnectorSolutionDir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), 'phase6a-'))
        Phase6aGolden.WriteSolution(dir, Phase6aGolden.ConnectorModelTodl)
        return dir
    }

    public static PlainSolutionDir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), 'phase6a-plain-'))
        Phase6aGolden.WriteSolution(dir, Phase6aGolden.PlainModelTodl)
        return dir
    }

    public static BuildPgMemPool(): unknown
    {
        const db = newDb()
        db.public.none('CREATE TABLE "Customer" (customer_id text, name text, description text, label text)')
        db.public.none(`INSERT INTO "Customer" (customer_id, name) VALUES ('C1', 'Acme')`)
        const pg = db.adapters.createPg()
        return new pg.Pool()
    }

    public static Cleanup(dir: string): void
    {
        rmSync(dir, { recursive: true, force: true })
    }
}

test('a solution model with a SQL datasource reads its entities through the worker connector runtime', async () =>
{
    const dir = Phase6aGolden.ConnectorSolutionDir()
    const pool = Phase6aGolden.BuildPgMemPool()
    const server = new PragmaticServer({ packagesRoot: join(dir, 'packages'), connectors: { buildPool: () => pool as never } })
    try
    {
        await server.Start()
        await server.OpenSolution(dir)
        const runtime = await server.Connectors()
        const models = runtime.ModelsWithConnectors()
        assert.equal(models.length, 1)
        assert.ok(models[0]!.Bindings.length >= 1)
        assert.equal(models[0]!.Bindings[0]!.Source, 'Customer')
        const entities = (await runtime.ReadEntities(models[0]!.ModelId, 'shop.Customer')).Entities
        assert.ok(entities.length >= 1)
    }
    finally
    {
        await server.Dispose()
        Phase6aGolden.Cleanup(dir)
    }
})

test('a solution with no datasource yields an empty connector model set', async () =>
{
    const dir = Phase6aGolden.PlainSolutionDir()
    const server = new PragmaticServer({ packagesRoot: join(dir, 'packages') })
    try
    {
        await server.Start()
        await server.OpenSolution(dir)
        const runtime = await server.Connectors()
        assert.equal(runtime.ModelsWithConnectors().length, 0)
    }
    finally
    {
        await server.Dispose()
        Phase6aGolden.Cleanup(dir)
    }
})
