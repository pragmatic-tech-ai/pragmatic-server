import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdpClientStore } from '../idp-client-store.js';

class ClientStoreFixture
{
    public static readonly TenantId = 'tenant-1';
    public static readonly OtherTenantId = 'tenant-2';
    public static readonly ClientId = 'client-1';
    public static readonly Secret = 'client-secret-correct-horse';
    public static readonly WrongSecret = 'nope';
    public static readonly Redirect = 'https://e/cb';
    public static readonly BadRedirects: readonly string[] = ['https://e/cb/../evil', 'https://e/cb?x=1', 'https://evil/cb', 'https://e/cb/', 'https://e/c', 'HTTPS://e/cb'];

    public static async Seeded(): Promise<IdpClientStore>
    {
        const store = new IdpClientStore();
        await store.Register(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId, [ClientStoreFixture.Redirect], ClientStoreFixture.Secret);
        return store;
    }
}

test('a registered client verifies its secret', async () =>
{
    const store = await ClientStoreFixture.Seeded();
    assert.equal(await store.VerifySecret(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId, ClientStoreFixture.Secret), true);
});

test('a wrong client secret is rejected', async () =>
{
    const store = await ClientStoreFixture.Seeded();
    assert.equal(await store.VerifySecret(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId, ClientStoreFixture.WrongSecret), false);
});

test('an unknown client verifies false without throwing', async () =>
{
    const store = await ClientStoreFixture.Seeded();
    assert.equal(await store.VerifySecret(ClientStoreFixture.TenantId, 'ghost', ClientStoreFixture.Secret), false);
    assert.equal(await store.VerifySecret(ClientStoreFixture.OtherTenantId, ClientStoreFixture.ClientId, ClientStoreFixture.Secret), false);
    assert.equal(store.Find(ClientStoreFixture.OtherTenantId, ClientStoreFixture.ClientId), undefined);
});

test('redirect_uri must match the allowlist exactly', async () =>
{
    const store = await ClientStoreFixture.Seeded();
    assert.equal(store.RedirectAllowed(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId, ClientStoreFixture.Redirect), true);
    for (const bad of ClientStoreFixture.BadRedirects)
    {
        assert.equal(store.RedirectAllowed(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId, bad), false, bad);
    }
    assert.equal(store.RedirectAllowed(ClientStoreFixture.TenantId, 'ghost', ClientStoreFixture.Redirect), false);
    assert.equal(store.RedirectAllowed(ClientStoreFixture.OtherTenantId, ClientStoreFixture.ClientId, ClientStoreFixture.Redirect), false);
});

test('the stored client secret is a hash, not the secret', async () =>
{
    const store = await ClientStoreFixture.Seeded();
    const client = store.Find(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId);
    assert.ok(client);
    assert.notEqual(client.SecretHash, ClientStoreFixture.Secret);
    assert.ok(!JSON.stringify(client).includes(ClientStoreFixture.Secret));
});
