import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { newDb } from 'pg-mem'
import { DataSourceKind } from '@pragmatic-tech-ai/todl'
import { EnvironmentRegistry, InMemoryEnvironmentProvisioning } from '../environment-registry.js'
import { InMemoryEnvironmentCoordinator } from '../environment-coordinator.js'
import type { EnvironmentProvisioning } from '../environment-provisioning.js'
import { ConnectorsPolicy } from '../../host/connector-policy.js'
import { DevConnectorRead } from '../../host/engine/tests/dev-connector-read.js'

class TwoEnvironmentPolicyFixture
{
    private static readonly EnvironmentOneId = 't1'
    private static readonly EnvironmentTwoId = 't2'
    private static readonly KeyEnv = 'PS_6C_2T_MASTER_KEY'
    private static readonly TempPrefix = 'ps-6c-2t-'
    private static readonly SolutionPrefix = 'ps-6c-sln-'
    private static readonly SolutionFile = 'Sample.pksln'
    private static readonly ModelsDir = 'models'
    private static readonly ProjectFile = 'project.plexus'
    private static readonly ModelFile = 'model.todl'
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

    private static ConnectorPool(): unknown
    {
        const db = newDb()
        db.public.none(TwoEnvironmentPolicyFixture.CreateTable)
        db.public.none(TwoEnvironmentPolicyFixture.InsertRow)
        return new (db.adapters.createPg()).Pool()
    }

    private static Provisioning(): InMemoryEnvironmentProvisioning
    {
        const pool = TwoEnvironmentPolicyFixture.ConnectorPool()
        const connectors = { buildPool: () => pool as never }
        const entries = new Map<string, EnvironmentProvisioning>([
            [TwoEnvironmentPolicyFixture.EnvironmentOneId, { displayName: 'Environment One', connectors, connectorsPolicy: new ConnectorsPolicy([DataSourceKind.Sql], true, false, []) }],
            [TwoEnvironmentPolicyFixture.EnvironmentTwoId, { displayName: 'Environment Two', connectors, connectorsPolicy: ConnectorsPolicy.Default() }],
        ])
        return new InMemoryEnvironmentProvisioning(entries)
    }

    private static SolutionDir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), TwoEnvironmentPolicyFixture.SolutionPrefix))
        writeFileSync(join(dir, TwoEnvironmentPolicyFixture.SolutionFile), JSON.stringify({ kind: 'todl-solution', version: 1, name: 'Sample', members: [{ path: TwoEnvironmentPolicyFixture.ModelsDir, type: 'meta-model' }], settings: {}, bags: {} }))
        mkdirSync(join(dir, TwoEnvironmentPolicyFixture.ModelsDir), { recursive: true })
        writeFileSync(join(dir, TwoEnvironmentPolicyFixture.ModelsDir, TwoEnvironmentPolicyFixture.ProjectFile), JSON.stringify({ type: 'meta-model', name: 'Shop Model', id: 'shop-model', packageVersion: '0.1.0' }))
        writeFileSync(join(dir, TwoEnvironmentPolicyFixture.ModelsDir, TwoEnvironmentPolicyFixture.ModelFile), TwoEnvironmentPolicyFixture.ModelTodl)
        return dir
    }

    public static async Run(): Promise<void>
    {
        const baseDir = mkdtempSync(join(tmpdir(), TwoEnvironmentPolicyFixture.TempPrefix))
        const dir1 = TwoEnvironmentPolicyFixture.SolutionDir()
        const dir2 = TwoEnvironmentPolicyFixture.SolutionDir()
        process.env[TwoEnvironmentPolicyFixture.KeyEnv] = randomBytes(32).toString('base64')
        const registry = new EnvironmentRegistry(baseDir, { base64Env: TwoEnvironmentPolicyFixture.KeyEnv }, TwoEnvironmentPolicyFixture.Provisioning(), new InMemoryEnvironmentCoordinator())
        try
        {
            const s1 = await registry.ServerFor(TwoEnvironmentPolicyFixture.EnvironmentOneId)
            const s2 = await registry.ServerFor(TwoEnvironmentPolicyFixture.EnvironmentTwoId)
            await s1.OpenSolution(dir1)
            await s2.OpenSolution(dir2)
            await assert.rejects(() => DevConnectorRead.Rows(s1, TwoEnvironmentPolicyFixture.ConceptId, TwoEnvironmentPolicyFixture.EnvironmentOneId), /catalog-only/)
            const entities = await DevConnectorRead.Rows(s2, TwoEnvironmentPolicyFixture.ConceptId, TwoEnvironmentPolicyFixture.EnvironmentTwoId)
            assert.ok(entities.length >= 1)
        }
        finally
        {
            await registry.DisposeAll()
            delete process.env[TwoEnvironmentPolicyFixture.KeyEnv]
            rmSync(baseDir, { recursive: true, force: true })
            rmSync(dir1, { recursive: true, force: true })
            rmSync(dir2, { recursive: true, force: true })
        }
    }
}

test('two environments get isolated connector policies: catalog-only rejects, permissive reads', async () =>
{
    await TwoEnvironmentPolicyFixture.Run()
})
