import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthorizationCodeBinding, InMemoryAuthorizationCodeStore } from '../authorization-code-store.js';

class AuthorizationCodeStoreTestFixture
{
    public static readonly Now = new Date('2026-01-01T00:00:00Z');

    public static Binding(expiresAt: Date): AuthorizationCodeBinding
    {
        return new AuthorizationCodeBinding('sub-1', 'tenant-1', 'client-1', 'https://app/cb', 'nonce-1', 'challenge-1', expiresAt);
    }

    public static Store(): InMemoryAuthorizationCodeStore
    {
        return new InMemoryAuthorizationCodeStore(() => AuthorizationCodeStoreTestFixture.Now);
    }
}

test('a code can be taken exactly once', async () =>
{
    const store = AuthorizationCodeStoreTestFixture.Store();
    const binding = AuthorizationCodeStoreTestFixture.Binding(new Date(AuthorizationCodeStoreTestFixture.Now.getTime() + 60_000));
    const code = await store.Issue(binding);
    assert.equal(await store.Take(code), binding);
    assert.equal(await store.Take(code), null);
});

test('an expired code is not returned', async () =>
{
    const store = AuthorizationCodeStoreTestFixture.Store();
    const code = await store.Issue(AuthorizationCodeStoreTestFixture.Binding(new Date(AuthorizationCodeStoreTestFixture.Now.getTime() - 1)));
    assert.equal(await store.Take(code), null);
});

test('an unknown code returns null', async () =>
{
    assert.equal(await AuthorizationCodeStoreTestFixture.Store().Take('nope'), null);
});
