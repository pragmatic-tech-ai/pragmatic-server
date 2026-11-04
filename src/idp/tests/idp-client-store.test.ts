import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
    assert.equal(await store.Remove(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId), true);
    assert.equal(store.Find(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId), undefined);
});

test('Remove of an unknown client returns false and changes nothing', async () =>
{
    const store = await ClientStoreFixture.Seeded();
    assert.equal(await store.Remove(ClientStoreFixture.TenantId, 'ghost'), false);
    assert.equal(await store.Remove(ClientStoreFixture.OtherTenantId, ClientStoreFixture.ClientId), false);
    assert.notEqual(store.Find(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId), undefined);
});

test('Remove leaves another client of the same tenant intact', async () =>
{
    const store = await ClientStoreFixture.Seeded();
    const otherClient = 'client-2';
    await store.Register(ClientStoreFixture.TenantId, otherClient, [ClientStoreFixture.Redirect], ClientStoreFixture.Secret);
    assert.equal(await store.Remove(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId), true);
    assert.equal(store.Find(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId), undefined);
    assert.notEqual(store.Find(ClientStoreFixture.TenantId, otherClient), undefined);
});

class DurableFixture
{
    public static readonly DirPrefix = 'idp-client-store-';
    public static readonly FileName = 'clients.json';

    public static async Run(body: (file: string) => Promise<void>): Promise<void>
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), DurableFixture.DirPrefix));
        try
        {
            await body(path.join(dir, DurableFixture.FileName));
        }
        finally
        {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
}

test('a durable store reloads its clients: same redirect allowlist, same secret verifies', () => DurableFixture.Run(async file =>
{
    const first = await IdpClientStore.Open(file);
    await first.Register(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId, [ClientStoreFixture.Redirect], ClientStoreFixture.Secret);
    const reopened = await IdpClientStore.Open(file);
    assert.equal(reopened.Find(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId)?.ClientId, ClientStoreFixture.ClientId);
    assert.equal(reopened.RedirectAllowed(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId, ClientStoreFixture.Redirect), true);
    assert.equal(await reopened.VerifySecret(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId, ClientStoreFixture.Secret), true);
    assert.equal(await reopened.VerifySecret(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId, ClientStoreFixture.WrongSecret), false);
}));

test('the durable file holds only the secret hash, never the secret', () => DurableFixture.Run(async file =>
{
    const store = await IdpClientStore.Open(file);
    await store.Register(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId, [ClientStoreFixture.Redirect], ClientStoreFixture.Secret);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.includes(ClientStoreFixture.Secret));
    assert.ok(text.includes(ClientStoreFixture.HashPrefix));
}));

test('a removal is durable, and a re-registration replaces the client', () => DurableFixture.Run(async file =>
{
    const store = await IdpClientStore.Open(file);
    await store.Register(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId, [ClientStoreFixture.Redirect], ClientStoreFixture.Secret);
    const other = 'client-2';
    await store.Register(ClientStoreFixture.TenantId, other, ['https://e/one'], ClientStoreFixture.Secret);
    await store.Register(ClientStoreFixture.TenantId, other, ['https://e/two'], ClientStoreFixture.Secret);
    assert.equal(await store.Remove(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId), true);
    const reopened = await IdpClientStore.Open(file);
    assert.equal(reopened.Find(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId), undefined);
    assert.equal(reopened.RedirectAllowed(ClientStoreFixture.TenantId, other, 'https://e/one'), false);
    assert.equal(reopened.RedirectAllowed(ClientStoreFixture.TenantId, other, 'https://e/two'), true);
}));

test('a missing file opens empty; an unreadable file is refused rather than silently dropping clients', () => DurableFixture.Run(async file =>
{
    const empty = await IdpClientStore.Open(file);
    assert.equal(empty.Find(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId), undefined);
    fs.writeFileSync(file, '{not json');
    await assert.rejects(IdpClientStore.Open(file), /client registrations/);
}));

class LoopbackFixture
{
    public static readonly Registered = 'http://127.0.0.1/pragmatic-desktop/callback';
    public static readonly PortFul = 'http://127.0.0.1:7000/cb';
    public static readonly Good: readonly string[] = ['http://127.0.0.1:51234/pragmatic-desktop/callback', 'http://127.0.0.1:1/pragmatic-desktop/callback', 'http://127.0.0.1:65535/pragmatic-desktop/callback'];
    public static readonly Bad: readonly string[] = [
        'http://127.0.0.1:5/other',
        'http://127.0.0.1:5/pragmatic-desktop/callback?x=1',
        'http://127.0.0.1:5/pragmatic-desktop/callback#f',
        'https://127.0.0.1:5/pragmatic-desktop/callback',
        'http://localhost:5/pragmatic-desktop/callback',
        'http://127.0.0.1.evil.test:5/pragmatic-desktop/callback',
        'http://127.0.0.1:0/pragmatic-desktop/callback',
        'not a url'];
    public static readonly PortFulOther = 'http://127.0.0.1:7001/cb';

    public static async Register(uri: string): Promise<IdpClientStore>
    {
        const store = new IdpClientStore();
        await store.Register(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId, [uri], ClientStoreFixture.Secret);
        return store;
    }
}

describe('loopback redirect', () =>
{
    it('matches any port on a registered portless 127.0.0.1 redirect', async () =>
    {
        const store = await LoopbackFixture.Register(LoopbackFixture.Registered);
        for (const uri of LoopbackFixture.Good)
        {
            assert.equal(store.RedirectAllowed(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId, uri), true, uri);
        }
    });

    it('refuses a different path, a query, a fragment, https, localhost or a port-ful registration mismatch', async () =>
    {
        const store = await LoopbackFixture.Register(LoopbackFixture.Registered);
        for (const uri of LoopbackFixture.Bad)
        {
            assert.equal(store.RedirectAllowed(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId, uri), false, uri);
        }
        const portFul = await LoopbackFixture.Register(LoopbackFixture.PortFul);
        assert.equal(portFul.RedirectAllowed(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId, LoopbackFixture.PortFul), true);
        assert.equal(portFul.RedirectAllowed(ClientStoreFixture.TenantId, ClientStoreFixture.ClientId, LoopbackFixture.PortFulOther), false);
    });
});
