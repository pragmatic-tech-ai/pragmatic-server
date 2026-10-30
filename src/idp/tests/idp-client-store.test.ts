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
    public static readonly HashPrefix = '$argon2';
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
    assert.ok(client.SecretHash.startsWith(ClientStoreFixture.HashPrefix));
    assert.ok(!JSON.stringify(client).includes(ClientStoreFixture.Secret));
});

test('the same clientId under two tenants stays distinct', async () =>
{
    const store = new IdpClientStore();
    const redirectA = 'https://a/cb';
    const redirectB = 'https://b/cb';
    await store.Register(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId, [redirectA], 'secret-a');
    await store.Register(ClientStoreFixture.OtherTenantId, ClientStoreFixture.ClientId, [redirectB], 'secret-b');
    assert.equal(await store.VerifySecret(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId, 'secret-a'), true);
    assert.equal(await store.VerifySecret(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId, 'secret-b'), false);
    assert.equal(await store.VerifySecret(ClientStoreFixture.OtherTenantId, ClientStoreFixture.ClientId, 'secret-b'), true);
    assert.equal(await store.VerifySecret(ClientStoreFixture.OtherTenantId, ClientStoreFixture.ClientId, 'secret-a'), false);
    assert.equal(store.RedirectAllowed(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId, redirectA), true);
    assert.equal(store.RedirectAllowed(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId, redirectB), false);
    assert.equal(store.RedirectAllowed(ClientStoreFixture.OtherTenantId, ClientStoreFixture.ClientId, redirectB), true);
    assert.equal(store.RedirectAllowed(ClientStoreFixture.OtherTenantId, ClientStoreFixture.ClientId, redirectA), false);
});

test('Remove of a registered client returns true and the client is gone', async () =>
{
    const store = await ClientStoreFixture.Seeded();
    assert.equal(store.Remove(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId), true);
    assert.equal(store.Find(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId), undefined);
});

test('Remove of an unknown client returns false and changes nothing', async () =>
{
    const store = await ClientStoreFixture.Seeded();
    assert.equal(store.Remove(ClientStoreFixture.TenantId, 'ghost'), false);
    assert.equal(store.Remove(ClientStoreFixture.OtherTenantId, ClientStoreFixture.ClientId), false);
    assert.notEqual(store.Find(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId), undefined);
});

test('Remove leaves another client of the same tenant intact', async () =>
{
    const store = await ClientStoreFixture.Seeded();
    const otherClient = 'client-2';
    await store.Register(ClientStoreFixture.TenantId, otherClient, [ClientStoreFixture.Redirect], ClientStoreFixture.Secret);
    assert.equal(store.Remove(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId), true);
    assert.equal(store.Find(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId), undefined);
    assert.notEqual(store.Find(ClientStoreFixture.TenantId, otherClient), undefined);
});
