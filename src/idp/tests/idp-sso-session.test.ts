import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdpSsoCookie, IdpSsoSessionStore } from '../idp-sso-session.js';

class IdpSsoSessionTestFixture
{
    public static readonly Start = new Date('2026-01-01T00:00:00Z');

    public Current = IdpSsoSessionTestFixture.Start;

    public Store(): IdpSsoSessionStore
    {
        return new IdpSsoSessionStore(() => this.Current);
    }
}

test('an issued session validates for its tenant', () =>
{
    const store = new IdpSsoSessionTestFixture().Store();
    const issued = store.Issue('user-1', 'tenant-1');
    const session = store.Validate(issued.Id, 'tenant-1');
    assert.equal(session?.PrincipalId, 'user-1');
    assert.equal(session?.TenantId, 'tenant-1');
});

test('it does not validate for a different tenant', () =>
{
    const store = new IdpSsoSessionTestFixture().Store();
    const issued = store.Issue('user-1', 'tenant-1');
    assert.equal(store.Validate(issued.Id, 'tenant-2'), null);
    assert.equal(store.Validate('unknown-id', 'tenant-1'), null);
});

test('an expired session is invalid', () =>
{
    const fixture = new IdpSsoSessionTestFixture();
    const store = fixture.Store();
    const issued = store.Issue('user-1', 'tenant-1');
    fixture.Current = new Date(issued.session.ExpiresAt.getTime() + 1);
    assert.equal(store.Validate(issued.Id, 'tenant-1'), null);
});

test('a revoked session is invalid', () =>
{
    const store = new IdpSsoSessionTestFixture().Store();
    const issued = store.Issue('user-1', 'tenant-1');
    store.Revoke(issued.Id);
    assert.equal(store.Validate(issued.Id, 'tenant-1'), null);
});

test('the cookie is HttpOnly, Path=/, SameSite=Lax, Secure when asked', () =>
{
    const expires = new Date('2026-01-02T00:00:00Z');
    const plain = IdpSsoCookie.Build('abc_-123', expires, false);
    assert.ok(plain.startsWith('idp_sso=abc_-123;'));
    assert.ok(plain.includes('HttpOnly'));
    assert.ok(plain.includes('Path=/'));
    assert.ok(plain.includes('SameSite=Lax'));
    assert.ok(!plain.includes('Strict'));
    assert.ok(!plain.includes('Secure'));
    assert.ok(plain.includes(`Expires=${expires.toUTCString()}`));
    const secure = IdpSsoCookie.Build('abc_-123', expires, true);
    assert.ok(secure.includes('; Secure'));
    assert.equal(IdpSsoCookie.Read(`other=1; ${plain.split(';')[0]}; x=y`), 'abc_-123');
    assert.equal(IdpSsoCookie.Read('other=1'), undefined);
    assert.equal(IdpSsoCookie.Read(undefined), undefined);
});
