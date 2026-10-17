import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newDb } from 'pg-mem'
import { InMemoryMessageSocket, PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import { WriteFailureKind } from '@pragmatic-tech-ai/todl'
import { PragmaticServer } from '../../pragmatic-server.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import { ConnectorService } from '../connector-service.js'

/** Drives connector/* over the in-memory transport against a server over a pg-mem fixture. */
class E2e
{
    private static readonly DirPrefix = 'ph6b-'
    private static readonly SolutionFile = 'Sample.pksln'
    private static readonly ModelsDir = 'models'
    private static readonly ProjectFile = 'project.plexus'
    private static readonly ModelFile = 'model.todl'
    private static readonly PackagesDir = 'packages'
    private static readonly ConnectorName = 'pg'
    private static readonly ConceptId = 'shop.Customer'
    private static readonly SecretMarker = 'password'
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
        const dir = mkdtempSync(join(tmpdir(), E2e.DirPrefix))
        writeFileSync(join(dir, E2e.SolutionFile), JSON.stringify({ kind: 'todl-solution', version: 1, name: 'Sample', members: [{ path: E2e.ModelsDir, type: 'meta-model' }], settings: {}, bags: {} }))
        mkdirSync(join(dir, E2e.ModelsDir), { recursive: true })
        writeFileSync(join(dir, E2e.ModelsDir, E2e.ProjectFile), JSON.stringify({ type: 'meta-model', name: 'Shop Model', id: 'shop-model', packageVersion: '0.1.0' }))
        writeFileSync(join(dir, E2e.ModelsDir, E2e.ModelFile), E2e.ModelTodl)
        return dir
    }

    private static Pool(): unknown
    {
        const db = newDb()
        db.public.none(E2e.CreateTable)
        db.public.none(E2e.InsertRow)
        return new (db.adapters.createPg()).Pool()
    }

    private static OwnerContext(): AccessContext
    {
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal('u1', 't1', PrincipalKind.User, new Map(), [])
        const grants = [new Grant('u1', Role.Owner, new ResourceRef(ResourceKind.Tenant, 't1', []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    public static async Run(): Promise<void>
    {
        const dir = E2e.SolutionDir()
        const pool = E2e.Pool()
        const server = new PragmaticServer({ packagesRoot: join(dir, E2e.PackagesDir), connectors: { buildPool: () => pool as never } })
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        let handler: ServerConnectionHandler | undefined
        let client: PragmaticClient | undefined
        try
        {
            await server.Start()
            await server.OpenSolution(dir)
            const languageService = await server.LanguageService()
            const manager = await server.Manager()
            handler = ServerConnectionHandler.Attach(serverSocket, languageService, manager, E2e.OwnerContext(), () => server.Connectors(), ctx => server.Graph(ctx))
            client = PragmaticClient.CreateOverSocket(clientSocket)
            const models = await client.Connectors()
            assert.equal(models.length, 1)
            const modelId = models[0]!.modelId
            const entities = (await client.ReadEntities(modelId, E2e.ConceptId)).items
            assert.ok(entities.length >= 1)
            assert.equal(entities[0]!.fields.name, 'Acme')
            const probe = await client.TestConnection(modelId, E2e.ConnectorName)
            assert.equal(probe.ok, true)
            const outcome = await client.WriteBack(modelId, [entities[0]!.id], [])
            assert.ok(Array.isArray(outcome.results))
            assert.equal(JSON.stringify([models, entities, probe, outcome]).includes(E2e.SecretMarker), false)
        }
        finally
        {
            try { await client?.DisposeAsync() } catch { /* keep cleaning up */ }
            try { handler?.Dispose() } catch { /* keep cleaning up */ }
            try { await server.Dispose() } catch { /* keep cleaning up */ }
            rmSync(dir, { recursive: true, force: true })
        }
    }
}

test('a client lists, reads (with fields), tests and writes back connectors over the wire', async () =>
{
    await E2e.Run()
})

test('connector/writeBack surfaces a failures list with distinct kinds', async () =>
{
    const outcome =
    {
        Results: [{
            Applied: 1,
            Failures: [
                { Key: 'C2', Kind: WriteFailureKind.Conflict, Reason: 'etag mismatch' },
                { Key: 'C3', Kind: WriteFailureKind.Error, Reason: 'driver blew up' },
            ],
        }],
        Diagnostics: [],
    }
    const runtime = { WriteBack: () => Promise.resolve(outcome) }
    const service = new ConnectorService(() => Promise.resolve(runtime as never))
    const result = await service.WriteBack({ modelId: 'm', dirty: ['C1', 'C2', 'C3'], deleted: [] })
    assert.equal(result.results.length, 1)
    const failures = result.results[0]!.failures
    assert.equal(failures.length, 2)
    assert.deepEqual([...failures.map(f => f.kind)].sort(), [WriteFailureKind.Conflict, WriteFailureKind.Error])
    assert.equal(failures.find(f => f.kind === WriteFailureKind.Conflict)!.key, 'C2')
    assert.equal(failures.find(f => f.kind === WriteFailureKind.Conflict)!.reason, 'etag mismatch')
    assert.equal(failures.find(f => f.kind === WriteFailureKind.Error)!.key, 'C3')
    assert.equal(failures.find(f => f.kind === WriteFailureKind.Error)!.reason, 'driver blew up')
})
