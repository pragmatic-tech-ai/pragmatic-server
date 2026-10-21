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
    public static readonly InventoryId = 'inventory'
    public static readonly ShopConflictId = 'shop-conflict'
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
    // Same bare connector name "pg" as shop, but a different namespace -> a distinct qualified id.
    private static readonly InventoryTodl = `
namespace inventory {
  concept Item { label : string; }
  datasource pg { kind = sql; database = "inv"; }
  model Inv : inventory {
    annotate entrypoint { }
    connect pg;
    populate Item key item_id { label = "label"; }
  }
}
`
    // Same namespace+connector as shop (identity shop@connector:pg) but a DIFFERENT config -> a conflict.
    private static readonly ShopConflictTodl = `
namespace shop {
  concept Customer { name : string; }
  datasource pg { kind = sql; database = "other"; }
  model Shop2 : shop {
    annotate entrypoint { }
    connect pg;
    populate Customer key customer_id { name = "name"; }
  }
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

    public async PublishInventory(): Promise<void>
    {
        await this.Publish(PlanFixture.InventoryId, PlanFixture.InventoryTodl)
    }

    public async PublishShopConflict(): Promise<void>
    {
        await this.Publish(PlanFixture.ShopConflictId, PlanFixture.ShopConflictTodl)
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

test('For keeps same-named connectors from different namespaces as distinct specs', async () =>
{
    const fx = new PlanFixture()
    try
    {
        await fx.PublishBound()
        await fx.PublishInventory()
        const plan = await AppConnectorPlan.For(fx.Storage, PlanFixture.Manifest(PlanFixture.BoundId, PlanFixture.InventoryId))
        assert.equal(plan.Connectors.length, 2)
        assert.deepEqual(plan.Connectors.map(c => c.Id).sort(), ['inventory@connector:pg', 'shop@connector:pg'])
        assert.deepEqual(plan.Connectors.map(c => c.Name), ['pg', 'pg'])
        // Every binding links to its own namespace's connector by the qualified ConnectorId.
        assert.equal(plan.Bindings.length, 2)
        for (const binding of plan.Bindings)
        {
            assert.ok(binding.ConnectorId === 'shop@connector:pg' || binding.ConnectorId === 'inventory@connector:pg')
            assert.equal(binding.Connector, 'pg')
        }
    }
    finally
    {
        fx.Dispose()
    }
})

test('For rejects two packages that declare the same connector identity with different config', async () =>
{
    const fx = new PlanFixture()
    try
    {
        await fx.PublishBound()
        await fx.PublishShopConflict()
        await assert.rejects(
            AppConnectorPlan.For(fx.Storage, PlanFixture.Manifest(PlanFixture.BoundId, PlanFixture.ShopConflictId)),
            /conflicting definitions/)
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

test('ForPackages reconstructs the merged plan from refs without a manifest', async () =>
{
    const fx = new PlanFixture()
    try
    {
        await fx.PublishBound()
        const manifest = PlanFixture.Manifest(PlanFixture.BoundId)
        const plan = await AppConnectorPlan.ForPackages(fx.Storage, manifest.packages, 'g', '0')
        assert.equal(plan.Model, 'g')
        assert.equal(plan.Version, '0')
        assert.equal(plan.Connectors.length, 1)
        assert.equal(plan.Bindings.length, 1)
        const viaFor = await AppConnectorPlan.For(fx.Storage, { name: 'g', version: '0', packages: manifest.packages })
        assert.deepEqual(viaFor, plan)
    }
    finally
    {
        fx.Dispose()
    }
})
