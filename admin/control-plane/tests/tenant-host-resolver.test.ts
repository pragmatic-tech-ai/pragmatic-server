import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PlatformDirectory } from '../platform-directory.js'
import type { TenantRecord } from '../platform-records.js'
import { TenantHostResolver } from '../tenant-auth/tenant-host-resolver.js'

class StubDirectory
{
    public constructor(private readonly ids: readonly string[])
    {
    }

    public GetTenant(id: string): TenantRecord | undefined
    {
        return this.ids.includes(id) ? ({ id } as TenantRecord) : undefined
    }
}

class ResolverKit
{
    public static readonly Base = 'admin.example.com'
    public static readonly Scheme = 'https'

    public static Make(...ids: string[]): TenantHostResolver
    {
        return new TenantHostResolver(ResolverKit.Base, ResolverKit.Scheme, new StubDirectory(ids) as unknown as PlatformDirectory)
    }
}

test('TenantFor resolves a known tenant subdomain, with or without a port', () =>
{
    const r = ResolverKit.Make('acme')
    assert.equal(r.TenantFor('acme.admin.example.com'), 'acme')
    assert.equal(r.TenantFor('acme.admin.example.com:8443'), 'acme')
})

test('TenantFor folds an uppercase label to lowercase and matches only lowercase-stored ids', () =>
{
    assert.equal(ResolverKit.Make('acme').TenantFor('ACME.admin.example.com'), 'acme')
    assert.equal(ResolverKit.Make('Acme').TenantFor('acme.admin.example.com'), undefined)
    assert.equal(ResolverKit.Make('Acme').TenantFor('Acme.admin.example.com'), undefined)
})

test('TenantFor rejects unknown, bare, nested, foreign, and absent hosts', () =>
{
    const r = ResolverKit.Make('acme')
    assert.equal(r.TenantFor('nope.admin.example.com'), undefined)
    assert.equal(r.TenantFor('admin.example.com'), undefined)
    assert.equal(r.TenantFor('.admin.example.com'), undefined)
    assert.equal(r.TenantFor('a.b.admin.example.com'), undefined)
    assert.equal(r.TenantFor('acme.evil.com'), undefined)
    assert.equal(r.TenantFor(undefined), undefined)
})

test('Accepts mirrors TenantFor', () =>
{
    const r = ResolverKit.Make('acme')
    assert.equal(r.Accepts('acme.admin.example.com'), true)
    assert.equal(r.Accepts('nope.admin.example.com'), false)
    assert.equal(r.Accepts(undefined), false)
})

test('CallbackFor builds the scheme + host + callback path', () =>
{
    assert.equal(ResolverKit.Make('acme').CallbackFor('acme.admin.example.com'), 'https://acme.admin.example.com/tenant-auth/oidc/callback')
})
