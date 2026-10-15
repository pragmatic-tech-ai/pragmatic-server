import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import { compilePackage, BlobPackageStore, StoragePackageSink } from '@pragmatic-tech-ai/todl'
import type { PragmaticAppManifest } from '../../apps/pragmatic-app-manifest.js'
import { AppConnectorPlan } from '../app-connector-plan.js'

class PlanFixture
{
    private static readonly DirPrefix = 'acp-'
    private static readonly Version = '1.0.0'
    private static readonly AppName = 'demo'
    private static readonly SourceUri = 'shop.todl'
    public static readonly BoundId = 'shop'
    public static readonly PlainId = 'plain'
    private static readonly BoundTodl = `
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
    private static readonly PlainTodl = `
namespace plain {
  concept Widget { label : string; }
}
`

    public readonly Dir = mkdtempSync(join(tmpdir(), PlanFixture.DirPrefix))
    public readonly Storage = new NodeFsStorage(this.Dir)

    public async Publish(id: string, text: string): Promise<void>
    {
        const outcome = compilePackage([], [{ uri: PlanFixture.SourceUri, text }], { id, version: PlanFixture.Version })
        assert.ok(outcome.ok, JSON.stringify(outcome.errors))
        await new BlobPackageStore(new StoragePackageSink(this.Storage)).persist(outcome.package!)
    }

    public async PublishBound(): Promise<void>
    {
        await this.Publish(PlanFixture.BoundId, PlanFixture.BoundTodl)
    }

    public async PublishPlain(): Promise<void>
    {
        await this.Publish(PlanFixture.PlainId, PlanFixture.PlainTodl)
    }

    public static Manifest(...ids: string[]): PragmaticAppManifest
    {
        return { name: PlanFixture.AppName, version: PlanFixture.Version, packages: ids.map(id => ({ id, version: PlanFixture.Version })) }
    }

    public Dispose(): void
    {
        rmSync(this.Dir, { recursive: true, force: true })
    }
}

test('For reconstructs the datasource and populate binding from the published package', async () =>
{
    const fx = new PlanFixture()
    try
    {
        await fx.PublishBound()
        const plan = await AppConnectorPlan.For(fx.Storage, PlanFixture.Manifest(PlanFixture.BoundId))
        assert.equal(plan.Connectors.length, 1)
        assert.equal(plan.Connectors[0]!.Name, 'pg')
        assert.equal(plan.Bindings.length, 1)
        const binding = plan.Bindings[0]!
        assert.ok(binding.Concept.endsWith('Customer'))
        assert.equal(binding.Connector, 'pg')
        assert.equal(binding.Source, 'Customer')
        assert.equal(binding.IdKey, 'customer_id')
        assert.equal(binding.FieldMap.name, 'name')
        assert.equal(binding.FieldMap.id, 'customer_id')
    }
    finally
    {
        fx.Dispose()
    }
})

test('For yields empty bindings for a package with no populate', async () =>
{
    const fx = new PlanFixture()
    try
    {
        await fx.PublishPlain()
        const plan = await AppConnectorPlan.For(fx.Storage, PlanFixture.Manifest(PlanFixture.PlainId))
        assert.deepEqual(plan.Bindings, [])
        assert.deepEqual(plan.Connectors, [])
    }
    finally
    {
        fx.Dispose()
    }
})
