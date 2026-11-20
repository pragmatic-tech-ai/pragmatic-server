import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ISecretStore } from '@pragmatic-tech-ai/pragmatic-identity'
import { ProvisionedSecretSource } from '../../config/provisioned-secret-source.js'
import { EnvironmentSecretProvisioner, ProvisionedSecretMissingError } from '../environment-secret-provisioner.js'

class FakeSecretStore implements ISecretStore
{
    public readonly entries = new Map<string, string>()

    public async Get(reference: string): Promise<string | null>
    {
        return this.entries.get(reference) ?? null
    }

    public async Put(reference: string, secret: string): Promise<void>
    {
        this.entries.set(reference, secret)
    }

    public async Delete(reference: string): Promise<void>
    {
        this.entries.delete(reference)
    }
}

test('writes a present ref through into the store', async () =>
{
    const store = new FakeSecretStore()
    const source = ProvisionedSecretSource.FromText('{"t1/oidc/client-secret":"s3cr3t"}')
    await new EnvironmentSecretProvisioner(source).EnsureAsync(store, ['t1/oidc/client-secret'])
    assert.equal(store.entries.get('t1/oidc/client-secret'), 's3cr3t')
})

test('leaves an already-present store value when the source lacks the ref', async () =>
{
    const store = new FakeSecretStore()
    store.entries.set('t1/bootstrap/admin', 'already-here')
    const source = ProvisionedSecretSource.FromText('{}')
    await new EnvironmentSecretProvisioner(source).EnsureAsync(store, ['t1/bootstrap/admin'])
    assert.equal(store.entries.get('t1/bootstrap/admin'), 'already-here')
})

test('throws ProvisionedSecretMissingError naming the ref when neither source nor store has it (Review Focus 1)', async () =>
{
    const store = new FakeSecretStore()
    const source = ProvisionedSecretSource.FromText('{}')
    await assert.rejects(
        () => new EnvironmentSecretProvisioner(source).EnsureAsync(store, ['t1/bootstrap/admin']),
        (e: unknown) =>
        {
            assert.ok(e instanceof ProvisionedSecretMissingError)
            assert.equal(e.Reference, 't1/bootstrap/admin')
            assert.match(e.message, /t1\/bootstrap\/admin/)
            return true
        })
})

test('throws for an empty ref string', async () =>
{
    const store = new FakeSecretStore()
    const source = ProvisionedSecretSource.FromText('{}')
    await assert.rejects(() => new EnvironmentSecretProvisioner(source).EnsureAsync(store, ['']), ProvisionedSecretMissingError)
})

test('an empty ref never calls the store', async () =>
{
    class ThrowingStore implements ISecretStore
    {
        public async Get(): Promise<string | null>
        {
            throw new Error('Get must not be called')
        }

        public async Put(): Promise<void>
        {
            throw new Error('Put must not be called')
        }

        public async Delete(): Promise<void>
        {
            throw new Error('Delete must not be called')
        }
    }
    const source = ProvisionedSecretSource.FromText('{}')
    await assert.rejects(() => new EnvironmentSecretProvisioner(source).EnsureAsync(new ThrowingStore(), ['']), ProvisionedSecretMissingError)
})

test('ignores a source key the environment does not name (Review Focus 4)', async () =>
{
    const store = new FakeSecretStore()
    const source = ProvisionedSecretSource.FromText('{"t1/oidc/client-secret":"s","other/environment/ref":"x"}')
    await new EnvironmentSecretProvisioner(source).EnsureAsync(store, ['t1/oidc/client-secret'])
    assert.equal(store.entries.has('other/environment/ref'), false)
    assert.equal(store.entries.size, 1)
})

test('overwrites an existing store value from the source (rotation)', async () =>
{
    const store = new FakeSecretStore()
    store.entries.set('t1/oidc/client-secret', 'old')
    const source = ProvisionedSecretSource.FromText('{"t1/oidc/client-secret":"new"}')
    await new EnvironmentSecretProvisioner(source).EnsureAsync(store, ['t1/oidc/client-secret'])
    assert.equal(store.entries.get('t1/oidc/client-secret'), 'new')
})
