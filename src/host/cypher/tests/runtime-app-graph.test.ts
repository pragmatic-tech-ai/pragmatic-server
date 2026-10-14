import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import {
    Repository, Cardinality, toJSON, BlobPackageStore, StoragePackageSink, StoragePackageSource, Cypher,
    type PackageDocument, type CompiledPackage,
} from '@pragmatic-tech-ai/todl'
import { PragmaticServer } from '../../../pragmatic-server.js'
import { TenantPurpose } from '../../../tenancy/tenant-purpose.js'
import { RuntimeAppGraph } from '../runtime-app-graph.js'
import type { PragmaticAppManifest } from '../../apps/pragmatic-app-manifest.js'

class PublishedFixture
{
    public static readonly Id = 'shop'
    public static readonly Version = '1.0.0'
    public static readonly Prefix = 'pkgs-'
    public static readonly AppName = 'demo'
    public static readonly AppVersion = '1.0.0'
    public static readonly AppsPrefix = 'apps-'
    public static readonly ManifestFile = 'application.json'
    public static readonly BaseGraphFor = 'BaseGraphFor'
    public static readonly SourceSuffix = '.todl'
    public static readonly Count = 'MATCH (w:Widget) RETURN count(w) AS n'
    public static readonly Labels = 'MATCH (w:Widget) RETURN w.label AS label'

    public readonly Dir = mkdtempSync(join(tmpdir(), PublishedFixture.Prefix))

    public async Publish(): Promise<void>
    {
        const doc = toJSON(PublishedFixture.Repo()) as PackageDocument
        const pkg: CompiledPackage = {
            id: PublishedFixture.Id,
            version: PublishedFixture.Version,
            document: doc,
            fullDocument: doc,
            sources: [{ uri: PublishedFixture.Id + PublishedFixture.SourceSuffix, text: '' }],
            classes: [],
        }
        await new BlobPackageStore(new StoragePackageSink(new NodeFsStorage(this.Dir))).persist(pkg)
    }

    public Manifest(): PragmaticAppManifest
    {
        return { name: PublishedFixture.AppName, version: PublishedFixture.AppVersion, packages: [{ id: PublishedFixture.Id, version: PublishedFixture.Version }] }
    }

    public readonly AppsDir = mkdtempSync(join(tmpdir(), PublishedFixture.AppsPrefix))

    public WriteApp(): void
    {
        mkdirSync(join(this.AppsDir, PublishedFixture.AppName))
        writeFileSync(join(this.AppsDir, PublishedFixture.AppName, PublishedFixture.ManifestFile), JSON.stringify(this.Manifest()))
    }

    public Dispose(): void
    {
        rmSync(this.Dir, { recursive: true, force: true })
        rmSync(this.AppsDir, { recursive: true, force: true })
    }

    private static Repo(): Repository
    {
        const repo = new Repository()
        repo.builder()
            .defineConcept('Element')
            .defineConcept('Widget', 'Element')
            .addField('Widget', 'label', 'string', Cardinality.Optional)
            .addConceptRelationship('Widget', 'next', ['Widget'], Cardinality.Optional, 'prev')
            .setNamespace('shop')
            .assertInstance('Widget', 'shop.hero')
            .setField('shop.hero', 'label', 'Hi')
            .assertInstance('Widget', 'shop.tail')
            .setField('shop.tail', 'label', 'Bye')
            .addRelationship('shop.hero', 'next', 'shop.tail')
            .commit()
        return repo
    }
}

test('published package instances are queryable via Cypher over the composed graph', async () =>
{
    const fx = new PublishedFixture()
    try
    {
        await fx.Publish()
        const source = new StoragePackageSource(new NodeFsStorage(fx.Dir))
        const query = await RuntimeAppGraph.BuildQuery(source, fx.Manifest())
        const engine = Cypher.CypherEngine.OverQuery(query)
        const count = engine.Execute(PublishedFixture.Count).Rows[0]?.[0]
        assert.equal(Number(count instanceof Cypher.ScalarValue ? count.Value : Number.NaN), 2)
        const labels = engine.Execute(PublishedFixture.Labels).Rows
            .map(r => (r[0] instanceof Cypher.ScalarValue ? String(r[0].Value) : '')).sort()
        assert.deepEqual(labels, ['Bye', 'Hi'])
    }
    finally
    {
        fx.Dispose()
    }
})

test('a failed app graph build is evicted so a later call retries', async () =>
{
    const fx = new PublishedFixture()
    const server = new PragmaticServer({ purpose: TenantPurpose.Runtime, applicationsRoot: fx.AppsDir, packagesRoot: fx.Dir })
    try
    {
        fx.WriteApp()
        const baseGraphFor = (name: string): Promise<unknown> => (server as any)[PublishedFixture.BaseGraphFor](name)
        await assert.rejects(baseGraphFor(PublishedFixture.AppName))
        await fx.Publish()
        const query = await baseGraphFor(PublishedFixture.AppName)
        assert.ok(query)
    }
    finally
    {
        await server.Dispose()
        fx.Dispose()
    }
})
