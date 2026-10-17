import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { newDb } from 'pg-mem'
import { DataSourceKind } from '@pragmatic-tech-ai/todl'
import { TenantRegistry, InMemoryTenantProvisioning } from '../tenant-registry.js'
import { InMemoryTenantCoordinator } from '../tenant-coordinator.js'
import type { TenantProvisioning } from '../tenant-provisioning.js'
import { ConnectorsPolicy } from '../../host/connector-policy.js'

class TwoTenantPolicyFixture
{
    private static readonly TenantOneId = 't1'
    private static readonly TenantTwoId = 't2'
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
        db.public.none(TwoTenantPolicyFixture.CreateTable)
        db.public.none(TwoTenantPolicyFixture.InsertRow)
        return new (db.adapters.createPg()).Pool()
    }

    private static Provisioning(): InMemoryTenantProvisioning
    {
        const pool = TwoTenantPolicyFixture.ConnectorPool()
        const connectors = { buildPool: () => pool as never }
        const entries = new Map<string, TenantProvisioning>([
            [TwoTenantPolicyFixture.TenantOneId, { displayName: 'Tenant One', connectors, connectorsPolicy: new ConnectorsPolicy([DataSourceKind.Sql], true, false, []) }],
            [TwoTenantPolicyFixture.TenantTwoId, { displayName: 'Tenant Two', connectors, connectorsPolicy: ConnectorsPolicy.Default() }],
        ])
        return new InMemoryTenantProvisioning(entries)
    }

    private static SolutionDir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), TwoTenantPolicyFixture.SolutionPrefix))
        writeFileSync(join(dir, TwoTenantPolicyFixture.SolutionFile), JSON.stringify({ kind: 'todl-solution', version: 1, name: 'Sample', members: [{ path: TwoTenantPolicyFixture.ModelsDir, type: 'meta-model' }], settings: {}, bags: {} }))
        mkdirSync(join(dir, TwoTenantPolicyFixture.ModelsDir), { recursive: true })
        writeFileSync(join(dir, TwoTenantPolicyFixture.ModelsDir, TwoTenantPolicyFixture.ProjectFile), JSON.stringify({ type: 'meta-model', name: 'Shop Model', id: 'shop-model', packageVersion: '0.1.0' }))
        writeFileSync(join(dir, TwoTenantPolicyFixture.ModelsDir, TwoTenantPolicyFixture.ModelFile), TwoTenantPolicyFixture.ModelTodl)
        return dir
    }

    public static async Run(): Promise<void>
    {
        const baseDir = mkdtempSync(join(tmpdir(), TwoTenantPolicyFixture.TempPrefix))
        const dir1 = TwoTenantPolicyFixture.SolutionDir()
        const dir2 = TwoTenantPolicyFixture.SolutionDir()
        process.env[TwoTenantPolicyFixture.KeyEnv] = randomBytes(32).toString('base64')
        const registry = new TenantRegistry(baseDir, { base64Env: TwoTenantPolicyFixture.KeyEnv }, TwoTenantPolicyFixture.Provisioning(), new InMemoryTenantCoordinator())
        try
        {
            const s1 = await registry.ServerFor(TwoTenantPolicyFixture.TenantOneId)
            const s2 = await registry.ServerFor(TwoTenantPolicyFixture.TenantTwoId)
            await s1.OpenSolution(dir1)
            await s2.OpenSolution(dir2)
            const r1 = await s1.Connectors()
            const r2 = await s2.Connectors()
            await assert.rejects(() => r1.ReadEntities(r1.ModelsWithConnectors()[0]!.ModelId, TwoTenantPolicyFixture.ConceptId), /catalog-only/)
            const entities = (await r2.ReadEntities(r2.ModelsWithConnectors()[0]!.ModelId, TwoTenantPolicyFixture.ConceptId)).Entities
            assert.ok(entities.length >= 1)
        }
        finally
        {
            await registry.DisposeAll()
            delete process.env[TwoTenantPolicyFixture.KeyEnv]
            rmSync(baseDir, { recursive: true, force: true })
            rmSync(dir1, { recursive: true, force: true })
            rmSync(dir2, { recursive: true, force: true })
        }
    }
}

test('two tenants get isolated connector policies: catalog-only rejects, permissive reads', async () =>
{
    await TwoTenantPolicyFixture.Run()
})
