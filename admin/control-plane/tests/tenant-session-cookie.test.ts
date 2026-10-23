import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TenantSessionCookie } from '../tenant-auth/tenant-session-cookie.js'

class CookieFixture
{
    public static readonly Tenant = 'acme-prod'
    public static readonly Token = 'abc_DEF-123'
    public static readonly Expiry = new Date(Date.now() + 3600000)
    public static readonly Pair = 'pts_session=acme-prod.abc_DEF-123'
}

test('Build then Read round-trips tenant (with dash) and token', () =>
{
    const header = TenantSessionCookie.Build(CookieFixture.Tenant, CookieFixture.Token, CookieFixture.Expiry, false).split(';')[0]
    assert.deepEqual(TenantSessionCookie.Read(header), { tenantId: CookieFixture.Tenant, token: CookieFixture.Token })
})

test('Read amid other cookies', () =>
{
    assert.deepEqual(TenantSessionCookie.Read('a=b; ' + CookieFixture.Pair), { tenantId: CookieFixture.Tenant, token: CookieFixture.Token })
})

test('Duplicate pts_session is null', () =>
{
    assert.equal(TenantSessionCookie.Read(CookieFixture.Pair + '; ' + CookieFixture.Pair), null)
})

test('Missing or garbled cookie is null', () =>
{
    assert.equal(TenantSessionCookie.Read(undefined), null)
    assert.equal(TenantSessionCookie.Read('other=1'), null)
    assert.equal(TenantSessionCookie.Read('pts_session=nodot'), null)
    assert.equal(TenantSessionCookie.Read('pts_session=t.bad token!'), null)
})

test('Secure attribute follows the flag', () =>
{
    assert.ok(TenantSessionCookie.Build(CookieFixture.Tenant, CookieFixture.Token, CookieFixture.Expiry, true).endsWith('; Secure'))
    assert.ok(!TenantSessionCookie.Build(CookieFixture.Tenant, CookieFixture.Token, CookieFixture.Expiry, false).includes('Secure'))
})

test('BuildClearing sets Max-Age=0', () =>
{
    assert.ok(TenantSessionCookie.BuildClearing(false).includes('Max-Age=0'))
})

test('A tenant containing a dot round-trips', () =>
{
    const header = TenantSessionCookie.Build('a.b.c', CookieFixture.Token, CookieFixture.Expiry, false).split(';')[0]
    assert.deepEqual(TenantSessionCookie.Read(header), { tenantId: 'a.b.c', token: CookieFixture.Token })
})

test('A malformed percent-escape in the tenant is null', () =>
{
    assert.equal(TenantSessionCookie.Read('pts_session=%E0.' + CookieFixture.Token), null)
})

test('A past expiry clamps Max-Age to 0', () =>
{
    const cookie = TenantSessionCookie.Build(CookieFixture.Tenant, CookieFixture.Token, new Date(Date.now() - 100000), false)
    assert.ok(cookie.includes('Max-Age=0'))
})
