import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DataSourceKind } from '@pragmatic-tech-ai/todl'
import type { ConnectorSpec } from '@pragmatic-tech-ai/todl'
import { ServiceProvider } from '@pragmatic-tech-ai/todl-runtime'
import { SecretStoreKey } from '@pragmatic-tech-ai/todl-identity'
import type { ISecretStore } from '@pragmatic-tech-ai/todl-identity'
import { FileConnectionResolver, ConnectionNotDeclaredError } from '../file-connection-resolver.js'
import type { FileConnection } from '../file-connection-resolver.js'

class Secrets implements ISecretStore
{
    public constructor(private readonly values: ReadonlyMap<string, string>)
    {
    }

    public async Get(reference: string): Promise<string | null>
    {
        return this.values.get(reference) ?? null
    }

    public async Put(): Promise<void>
    {
    }

    public async Delete(): Promise<void>
    {
    }
}

class Fixture
{
    public static Provider(secrets: ReadonlyMap<string, string>): ServiceProvider
    {
        const provider = new ServiceProvider()
        provider.registerInstance(SecretStoreKey, new Secrets(secrets))
        return provider
    }

    public static Spec(extra: Partial<ConnectorSpec>): ConnectorSpec
    {
        return { Name: 'pg', Kind: DataSourceKind.Sql, Config: {}, ...extra }
    }

    public static Map(entries: Array<[string, FileConnection]>): ReadonlyMap<string, FileConnection>
    {
        return new Map<string, FileConnection>(entries)
    }
}

test('an inline spec (no Connection) passes through unchanged (Review Focus 5)', async () =>
{
    const resolver = new FileConnectionResolver(Fixture.Map([]))
    const resolved = await resolver.Resolve(Fixture.Spec({ Config: { database: 'inline' }, Secret: 'x' }), Fixture.Provider(new Map()))
    assert.deepEqual(resolved, { Kind: DataSourceKind.Sql, Config: { database: 'inline' }, Secret: 'x' })
})

test('a declared connection merges settings then inline Config (inline wins) (Review Focus 5)', async () =>
{
    const resolver = new FileConnectionResolver(Fixture.Map([['crm', { Settings: { host: 'h', database: 'base' } }]]))
    const resolved = await resolver.Resolve(Fixture.Spec({ Connection: 'crm', Config: { database: 'override' } }), Fixture.Provider(new Map()))
    assert.equal(resolved.Config.host, 'h')
    assert.equal(resolved.Config.database, 'override')
})

test('resolves the connection secretRef from the per-tenant secret store', async () =>
{
    const resolver = new FileConnectionResolver(Fixture.Map([['crm', { Settings: { database: 'd' }, SecretRef: 't1/crm/pw' }]]))
    const resolved = await resolver.Resolve(Fixture.Spec({ Connection: 'crm' }), Fixture.Provider(new Map([['t1/crm/pw', 's3cr3t']])))
    assert.equal(resolved.Secret, 's3cr3t')
})

test('a model-level spec.Secret wins over the connection secretRef', async () =>
{
    const resolver = new FileConnectionResolver(Fixture.Map([['crm', { Settings: { database: 'd' }, SecretRef: 't1/crm/pw' }]]))
    const resolved = await resolver.Resolve(Fixture.Spec({ Connection: 'crm', Secret: 'model-ref' }), Fixture.Provider(new Map([['model-ref', 'from-model'], ['t1/crm/pw', 'from-conn']])))
    assert.equal(resolved.Secret, 'from-model')
})

test('an unresolved secretRef yields no Secret, not a throw (Review Focus 3)', async () =>
{
    const resolver = new FileConnectionResolver(Fixture.Map([['crm', { Settings: { database: 'd' }, SecretRef: 't1/crm/pw' }]]))
    const resolved = await resolver.Resolve(Fixture.Spec({ Connection: 'crm' }), Fixture.Provider(new Map()))
    assert.equal(resolved.Secret, undefined)
})

test('an undeclared connection fails closed naming the connector and connection (Review Focus 1)', async () =>
{
    const resolver = new FileConnectionResolver(Fixture.Map([]))
    await assert.rejects(
        () => resolver.Resolve(Fixture.Spec({ Name: 'pg', Connection: 'ghost' }), Fixture.Provider(new Map())),
        (e: unknown) =>
        {
            assert.ok(e instanceof ConnectionNotDeclaredError)
            assert.equal(e.Connector, 'pg')
            assert.equal(e.Connection, 'ghost')
            assert.match(e.message, /pg/)
            assert.match(e.message, /ghost/)
            return true
        })
})

test('a connection with a tokenEnvVar reads the secret from the environment', async () =>
{
    process.env.PS_FCR_TEST_TOKEN = 'env-secret'
    try
    {
        const resolver = new FileConnectionResolver(Fixture.Map([['crm', { Settings: { database: 'd' }, TokenEnvVar: 'PS_FCR_TEST_TOKEN' }]]))
        const resolved = await resolver.Resolve(Fixture.Spec({ Connection: 'crm' }), Fixture.Provider(new Map()))
        assert.equal(resolved.Secret, 'env-secret')
    }
    finally
    {
        delete process.env.PS_FCR_TEST_TOKEN
    }
})

test('a model-level spec.Secret that is unresolved yields no Secret (no fallthrough to SecretRef)', async () =>
{
    const resolver = new FileConnectionResolver(Fixture.Map([['crm', { Settings: { database: 'd' }, SecretRef: 't1/crm/pw' }]]))
    const resolved = await resolver.Resolve(Fixture.Spec({ Connection: 'crm', Secret: 'model-ref' }), Fixture.Provider(new Map([['t1/crm/pw', 'conn-value']])))
    assert.equal(resolved.Secret, undefined)
})

test('connection SecretRef takes precedence over tokenEnvVar', async () =>
{
    process.env.PS_FCR_TEST_TOKEN2 = 'env-value'
    try
    {
        const resolver = new FileConnectionResolver(Fixture.Map([['crm', { Settings: { database: 'd' }, SecretRef: 't1/crm/pw', TokenEnvVar: 'PS_FCR_TEST_TOKEN2' }]]))
        const resolved = await resolver.Resolve(Fixture.Spec({ Connection: 'crm' }), Fixture.Provider(new Map([['t1/crm/pw', 'ref-value']])))
        assert.equal(resolved.Secret, 'ref-value')
    }
    finally
    {
        delete process.env.PS_FCR_TEST_TOKEN2
    }
})

test('a connection with no secret fields yields no Secret', async () =>
{
    const resolver = new FileConnectionResolver(Fixture.Map([['crm', { Settings: { database: 'd' } }]]))
    const resolved = await resolver.Resolve(Fixture.Spec({ Connection: 'crm' }), Fixture.Provider(new Map()))
    assert.equal(resolved.Secret, undefined)
    assert.equal(resolved.Config.database, 'd')
})

test('an empty-string connection secretRef falls through to tokenEnvVar', async () =>
{
    process.env.PS_FCR_EMPTY_FALLTHROUGH = 'env-token'
    try
    {
        const resolver = new FileConnectionResolver(Fixture.Map([['crm', { Settings: { database: 'd' }, SecretRef: '', TokenEnvVar: 'PS_FCR_EMPTY_FALLTHROUGH' }]]))
        const resolved = await resolver.Resolve(Fixture.Spec({ Connection: 'crm' }), Fixture.Provider(new Map()))
        assert.equal(resolved.Secret, 'env-token')
    }
    finally
    {
        delete process.env.PS_FCR_EMPTY_FALLTHROUGH
    }
})
