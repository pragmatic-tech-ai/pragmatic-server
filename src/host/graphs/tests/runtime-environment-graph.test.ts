import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    Repository, toJSON, Cypher,
    type PackageDocument,
} from '@pragmatic-tech-ai/todl'
import type { ContributedPackageDto, GraphLoadParamsDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { PragmaticServer } from '../../../pragmatic-server.js'
import { TenantPurpose } from '../../../tenancy/tenant-purpose.js'

/** Builds a runtime server over throwaway packages/graphs volumes and the contributed-package payloads to load. */
class RuntimeGraphFixture
{
    private static readonly PackagesPrefix = 'env-pkgs-'
    private static readonly GraphsPrefix = 'env-graphs-'
    public static readonly Version = '1.0.0'
    private static readonly SourceSuffix = '.todl'

    private readonly packages = mkdtempSync(join(tmpdir(), RuntimeGraphFixture.PackagesPrefix))
    private readonly graphs = mkdtempSync(join(tmpdir(), RuntimeGraphFixture.GraphsPrefix))
    private server: PragmaticServer | undefined
    private readonly coldServers: PragmaticServer[] = []

    public Server(purpose: TenantPurpose = TenantPurpose.Runtime): PragmaticServer
    {
        this.server ??= new PragmaticServer({ purpose, packagesRoot: this.packages, graphsRoot: this.graphs })
        return this.server
    }

    /** A cold server over the SAME volumes: simulates the per-tenant host after idle teardown or a restart — no live instance held, but the persisted record and immutably-stored packages are intact. */
    public ColdServer(purpose: TenantPurpose = TenantPurpose.Runtime): PragmaticServer
    {
        const server = new PragmaticServer({ purpose, packagesRoot: this.packages, graphsRoot: this.graphs })
        this.coldServers.push(server)
        return server
    }

    public static Package(namespace: string): ContributedPackageDto
    {
        const repo = new Repository()
        repo.builder()
            .defineConcept('Element')
            .defineConcept('Widget', 'Element')
            .setNamespace(namespace)
            .assertInstance('Widget', `${namespace}.one`)
            .commit()
        const document = toJSON(repo) as PackageDocument
        return { id: namespace, version: RuntimeGraphFixture.Version, modelJson: JSON.stringify(document) }
    }

    public static Params(graphName: string, namespaces: readonly string[]): GraphLoadParamsDto
    {
        return { graphName, packages: namespaces.map(n => RuntimeGraphFixture.Package(n)) }
    }

    public async Dispose(): Promise<void>
    {
        await this.server?.Dispose()
        for (const cold of this.coldServers)
        {
            await cold.Dispose()
        }
        rmSync(this.packages, { recursive: true, force: true })
        rmSync(this.graphs, { recursive: true, force: true })
    }
}

test('LoadEnvironmentGraph builds + persists and LoadedGraph reads it back', async () =>
{
    const fx = new RuntimeGraphFixture()
    try
    {
        const server = fx.Server()
        const record = await server.LoadEnvironmentGraph(RuntimeGraphFixture.Params('env', ['alpha']))
        assert.equal(record.name, 'env')
        assert.deepEqual(record.packages, [{ id: 'alpha', version: RuntimeGraphFixture.Version }])
        const loaded = await server.LoadedGraph()
        assert.deepEqual(loaded, record)
        const query = await server.EnvironmentGraphQuery()
        const count = Cypher.CypherEngine.OverQuery(query).Execute('MATCH (w:Widget) RETURN count(w) AS n').Rows[0]?.[0]
        assert.equal(Number(count instanceof Cypher.ScalarValue ? count.Value : Number.NaN), 1)
    }
    finally
    {
        await fx.Dispose()
    }
})

test('second_load_replaces_instance_and_record', async () =>
{
    const fx = new RuntimeGraphFixture()
    try
    {
        const server = fx.Server()
        await server.LoadEnvironmentGraph(RuntimeGraphFixture.Params('first', ['alpha']))
        const second = await server.LoadEnvironmentGraph(RuntimeGraphFixture.Params('second', ['beta', 'gamma']))
        const loaded = await server.LoadedGraph()
        assert.equal(loaded?.name, 'second')
        assert.deepEqual(loaded?.packages, [{ id: 'beta', version: RuntimeGraphFixture.Version }, { id: 'gamma', version: RuntimeGraphFixture.Version }])
        assert.equal(second.name, 'second')
    }
    finally
    {
        await fx.Dispose()
    }
})

test('load_empty_package_set_builds_empty_instance', async () =>
{
    const fx = new RuntimeGraphFixture()
    try
    {
        const server = fx.Server()
        const record = await server.LoadEnvironmentGraph(RuntimeGraphFixture.Params('empty', []))
        assert.deepEqual(record.packages, [])
        const loaded = await server.LoadedGraph()
        assert.equal(loaded?.name, 'empty')
        assert.deepEqual(loaded?.packages, [])
        assert.ok(await server.EnvironmentGraphQuery())
    }
    finally
    {
        await fx.Dispose()
    }
})

test('LoadEnvironmentGraph on a development server throws', async () =>
{
    const fx = new RuntimeGraphFixture()
    try
    {
        const server = fx.Server(TenantPurpose.Development)
        await assert.rejects(server.LoadEnvironmentGraph(RuntimeGraphFixture.Params('env', ['alpha'])))
    }
    finally
    {
        await fx.Dispose()
    }
})

test('EnvironmentGraphQuery rehydrates from the persisted record on a cold host (idle teardown / restart)', async () =>
{
    const fx = new RuntimeGraphFixture()
    try
    {
        await fx.Server().LoadEnvironmentGraph(RuntimeGraphFixture.Params('env', ['alpha']))
        // A cold host over the same volumes holds no live instance — a read must rebuild it from
        // the persisted loaded-manifest record + the stored packages, not throw.
        const cold = fx.ColdServer()
        const query = await cold.EnvironmentGraphQuery()
        const count = Cypher.CypherEngine.OverQuery(query).Execute('MATCH (w:Widget) RETURN count(w) AS n').Rows[0]?.[0]
        assert.equal(Number(count instanceof Cypher.ScalarValue ? count.Value : Number.NaN), 1)
    }
    finally
    {
        await fx.Dispose()
    }
})

test('EnvironmentGraphQuery throws NoEnvironmentGraphError when nothing was ever promoted', async () =>
{
    const fx = new RuntimeGraphFixture()
    try
    {
        await assert.rejects(fx.Server().EnvironmentGraphQuery(), /no environment graph is loaded/)
    }
    finally
    {
        await fx.Dispose()
    }
})
