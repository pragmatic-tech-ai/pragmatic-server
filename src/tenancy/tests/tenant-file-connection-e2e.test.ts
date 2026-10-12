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
import { FileConnectionResolver } from '../../host/file-connection-resolver.js'
import type { FileConnection } from '../../host/file-connection-resolver.js'
import { ProvisionedSecretSource } from '../../config/provisioned-secret-source.js'

class Fixture
{
    private static readonly KeyEnv = 'PS_FCONN_E2E_KEY'
    private static readonly ConceptId = 'shop.Customer'
    private static readonly CreateTable = 'CREATE TABLE "Customer" (customer_id text PRIMARY KEY, name text, description text, label text)'
    private static readonly InsertRow = `INSERT INTO "Customer" (customer_id, name) VALUES ('C1', 'Acme')`
    private static readonly ModelNamed = `
namespace shop {
  concept Customer { name : string; }
  datasource pg { kind = sql; connection = "crm"; }
  model Shop : shop { annotate entrypoint { } connect pg; populate Customer key customer_id { name = "name"; } }
}
`
    private static readonly ModelUndeclared = `
namespace shop {
  concept Customer { name : string; }
  datasource pg { kind = sql; connection = "ghost"; }
  model Shop : shop { annotate entrypoint { } connect pg; populate Customer key customer_id { name = "name"; } }
}
`

    private static Pool(): unknown
    {
        const db = newDb()
        db.public.none(Fixture.CreateTable)
        db.public.none(Fixture.InsertRow)
        return new (db.adapters.createPg()).Pool()
    }

    private static SolutionDir(model: string): string
    {
        const dir = mkdtempSync(join(tmpdir(), 'ps-fconn-sln-'))
        writeFileSync(join(dir, 'Sample.pksln'), JSON.stringify({ kind: 'todl-solution', version: 1, name: 'Sample', members: [{ path: 'models', type: 'meta-model' }], settings: {}, bags: {} }))
        mkdirSync(join(dir, 'models'), { recursive: true })
        writeFileSync(join(dir, 'models', 'project.plexus'), JSON.stringify({ type: 'meta-model', name: 'Shop Model', id: 'shop-model', packageVersion: '0.1.0' }))
        writeFileSync(join(dir, 'models', 'model.todl'), model)
        return dir
    }

    private static Captured: Record<string, unknown> | undefined

    private static Provisioning(): InMemoryTenantProvisioning
    {
        const pool = Fixture.Pool()
        const capturingPool = (options: unknown) =>
        {
            Fixture.Captured = options as Record<string, unknown>
            return pool as never
        }
        const resolverFor = (map: Array<[string, FileConnection]>) => new FileConnectionResolver(new Map<string, FileConnection>(map))
        const entries = new Map<string, TenantProvisioning>([
            ['t1', { displayName: 'Declared', connectorsPolicy: new ConnectorsPolicy([DataSourceKind.Sql], true, false, []),
                connectors: { buildPool: capturingPool, connectionResolver: resolverFor([['crm', { Settings: { database: 'app' }, SecretRef: 't1/crm/pw' }]]) }, connectorSecretRefs: ['t1/crm/pw'] }],
            ['t2', { displayName: 'Undeclared', connectorsPolicy: new ConnectorsPolicy([DataSourceKind.Sql], true, false, []),
                connectors: { buildPool: () => pool as never, connectionResolver: resolverFor([]) } }],
        ])
        return new InMemoryTenantProvisioning(entries)
    }

    public static async Run(): Promise<void>
    {
        Fixture.Captured = undefined
        const baseDir = mkdtempSync(join(tmpdir(), 'ps-fconn-'))
        const dir1 = Fixture.SolutionDir(Fixture.ModelNamed)
        const dir2 = Fixture.SolutionDir(Fixture.ModelUndeclared)
        process.env[Fixture.KeyEnv] = randomBytes(32).toString('base64')
        const source = ProvisionedSecretSource.FromText('{"t1/crm/pw":"db-password"}')
        const registry = new TenantRegistry(baseDir, { base64Env: Fixture.KeyEnv }, Fixture.Provisioning(), new InMemoryTenantCoordinator(), undefined, undefined, undefined, source)
        try
        {
            const s1 = await registry.ServerFor('t1')
            const s2 = await registry.ServerFor('t2')
            await s1.OpenSolution(dir1)
            await s2.OpenSolution(dir2)
            const r1 = await s1.Connectors()
            const r2 = await s2.Connectors()
            const rows = await r1.ReadEntities(r1.ModelsWithConnectors()[0]!.ModelId, Fixture.ConceptId)
            assert.ok(rows.length >= 1)
            assert.equal(Fixture.Captured?.database, 'app')
            assert.equal(Fixture.Captured?.password, 'db-password')
            await assert.rejects(() => r2.ReadEntities(r2.ModelsWithConnectors()[0]!.ModelId, Fixture.ConceptId), /is not declared/)
        }
        finally
        {
            await registry.DisposeAll()
            delete process.env[Fixture.KeyEnv]
            rmSync(baseDir, { recursive: true, force: true })
            rmSync(dir1, { recursive: true, force: true })
            rmSync(dir2, { recursive: true, force: true })
        }
    }
}

test('a tenant opens a connector through a file-declared connection; an undeclared connection fails closed (Review Focus 1, 2)', async () =>
{
    await Fixture.Run()
})
