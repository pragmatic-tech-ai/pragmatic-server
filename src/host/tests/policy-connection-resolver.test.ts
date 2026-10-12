import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ServiceProvider } from '@pragmatic-tech-ai/todl-runtime'
import { DataSourceKind } from '@pragmatic-tech-ai/todl'
import type { ConnectorSpec } from '@pragmatic-tech-ai/todl'
import type { IServiceProvider } from '@pragmatic-tech-ai/todl-runtime'
import { ConnectorsPolicy } from '../connector-policy.js'
import { PolicyConnectionResolver } from '../policy-connection-resolver.js'

class Specs
{
    public static get Services(): IServiceProvider
    {
        return new ServiceProvider()
    }

    public static Inline(kind: DataSourceKind = DataSourceKind.Sql): ConnectorSpec
    {
        return { Name: 'pg', Kind: kind, Config: { database: 'app' } }
    }

    public static Named(kind: DataSourceKind = DataSourceKind.Sql): ConnectorSpec
    {
        return { Name: 'pg', Kind: kind, Connection: 'crm-postgres', Config: {} }
    }
}

test('permissive default resolves an inline spec (pass-through to inline)', async () =>
{
    const resolver = new PolicyConnectionResolver(ConnectorsPolicy.Default())
    const resolved = await resolver.Resolve(Specs.Inline(), Specs.Services)
    assert.equal(resolved.Kind, DataSourceKind.Sql)
    assert.equal(resolved.Config.database, 'app')
})

test('an adapter kind outside the allowlist is rejected', async () =>
{
    const policy = new ConnectorsPolicy([DataSourceKind.Rest], false, false, [])
    const resolver = new PolicyConnectionResolver(policy)
    await assert.rejects(() => resolver.Resolve(Specs.Inline(DataSourceKind.Sql), Specs.Services), /adapter-not-allowed/)
})

test('an allowed adapter kind passes the allowlist', async () =>
{
    const policy = new ConnectorsPolicy([DataSourceKind.Sql], false, false, [])
    const resolver = new PolicyConnectionResolver(policy)
    const resolved = await resolver.Resolve(Specs.Inline(DataSourceKind.Sql), Specs.Services)
    assert.equal(resolved.Kind, DataSourceKind.Sql)
})

test('catalog-only rejects an inline spec (no named Connection)', async () =>
{
    const policy = new ConnectorsPolicy([DataSourceKind.Sql], true, false, [])
    const resolver = new PolicyConnectionResolver(policy)
    await assert.rejects(() => resolver.Resolve(Specs.Inline(), Specs.Services), /catalog-only/)
})

test('catalog-only allows a named-Connection spec (delegates to inner)', async () =>
{
    // inner stub: proves delegation happens for a named spec under catalog-only
    const inner = { Resolve: (s: ConnectorSpec) => Promise.resolve({ Kind: s.Kind, Config: { ok: 'yes' } }) }
    const policy = new ConnectorsPolicy([DataSourceKind.Sql], true, false, [])
    const resolver = new PolicyConnectionResolver(policy, inner)
    const resolved = await resolver.Resolve(Specs.Named(), Specs.Services)
    assert.equal(resolved.Config.ok, 'yes')
})

test('provider gate is inert for a normal spec (no provider field) — resolves fine', async () =>
{
    const policy = new ConnectorsPolicy([DataSourceKind.Sql], false, false, [])
    const resolver = new PolicyConnectionResolver(policy)
    const resolved = await resolver.Resolve(Specs.Inline(), Specs.Services)
    assert.equal(resolved.Kind, DataSourceKind.Sql)
})

test('Default allows all four kinds and is not catalog-only', () =>
{
    const d = ConnectorsPolicy.Default()
    assert.deepEqual([...d.AdapterAllowlist].sort(), [DataSourceKind.Cypher, DataSourceKind.Document, DataSourceKind.Rest, DataSourceKind.Sql].sort())
    assert.equal(d.CatalogOnly, false)
    assert.equal(d.AllowProviderOverride, false)
})
