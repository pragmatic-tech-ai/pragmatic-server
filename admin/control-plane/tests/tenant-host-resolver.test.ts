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

    // A local, proxy-less tenant plane: http on an external port.
    public static Local(port: number | undefined, scheme: string = 'http'): TenantHostResolver
    {
        return new TenantHostResolver('localhost', scheme, new StubDirectory(['pragmatic-default']) as unknown as PlatformDirectory, port)
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

test('rejects a blank or leading-dot base domain at construction', () =>
{
    const dir = new StubDirectory(['acme']) as unknown as PlatformDirectory
    assert.throws(() => new TenantHostResolver('', ResolverKit.Scheme, dir))
    assert.throws(() => new TenantHostResolver('.admin.example.com', ResolverKit.Scheme, dir))
})

test('with an external port the callback origin carries it: no more landing on port 80', () =>
{
    const r = ResolverKit.Local(7002)
    assert.equal(r.CallbackFor('pragmatic-default.localhost:7002'), 'http://pragmatic-default.localhost:7002/tenant-auth/oidc/callback')
    // The origin is the configured one, whatever port the Host header carried.
    assert.equal(r.CallbackFor('pragmatic-default.localhost'), 'http://pragmatic-default.localhost:7002/tenant-auth/oidc/callback')
    assert.equal(r.OriginFor('pragmatic-default.localhost:7002'), 'http://pragmatic-default.localhost:7002')
})

test('without an external port, or with the scheme default, the origin has no port (unchanged)', () =>
{
    for (const r of [ResolverKit.Local(undefined), ResolverKit.Local(80), ResolverKit.Local(443, 'https')])
    {
        assert.ok(!/:\d+\//.test(r.CallbackFor('pragmatic-default.localhost:7002')))
    }
    assert.equal(ResolverKit.Local(undefined).CallbackFor('pragmatic-default.localhost:7002'), 'http://pragmatic-default.localhost/tenant-auth/oidc/callback')
    assert.equal(ResolverKit.Local(443, 'https').CallbackFor('pragmatic-default.localhost'), 'https://pragmatic-default.localhost/tenant-auth/oidc/callback')
})

test('with an external port the host matches the tenant with or without that port, and nothing else', () =>
{
    const r = ResolverKit.Local(7002)
    assert.equal(r.TenantFor('pragmatic-default.localhost:7002'), 'pragmatic-default')
    assert.equal(r.TenantFor('pragmatic-default.localhost'), 'pragmatic-default')
    assert.equal(r.TenantFor('pragmatic-default.localhost:7003'), undefined)
    assert.equal(r.TenantFor('other.localhost:7002'), undefined)
    assert.equal(r.TenantFor('localhost:7002'), undefined)
    assert.equal(r.TenantFor('pragmatic-default.localhost.evil.com:7002'), undefined)
    assert.equal(r.TenantFor('a.pragmatic-default.localhost:7002'), undefined)
})

test('without an external port any Host port still matches (unchanged behaviour)', () =>
{
    assert.equal(ResolverKit.Local(undefined).TenantFor('pragmatic-default.localhost:7002'), 'pragmatic-default')
    assert.equal(ResolverKit.Local(undefined).TenantFor('pragmatic-default.localhost:9999'), 'pragmatic-default')
})

test('rejects an external port outside 1..65535 at construction', () =>
{
    for (const bad of [0, 70000, 1.5, -1])
    {
        assert.throws(() => ResolverKit.Local(bad))
    }
})

test('OriginAllowed: absent is allowed; a present Origin must be exactly the tenant origin (scheme, host, external port)', () =>
{
    const local = ResolverKit.Local(7002)
    const host = 'pragmatic-default.localhost:7002'
    assert.equal(local.OriginAllowed(undefined, host), true)
    assert.equal(local.OriginAllowed('http://pragmatic-default.localhost:7002', host), true)
    assert.equal(local.OriginAllowed('HTTP://Pragmatic-Default.LOCALHOST:7002', host), true)
    assert.equal(local.OriginAllowed('http://pragmatic-default.localhost:7003', host), false)
    assert.equal(local.OriginAllowed('https://pragmatic-default.localhost:7002', host), false)
    assert.equal(local.OriginAllowed('http://other.localhost:7002', host), false)
    assert.equal(local.OriginAllowed('null', host), false)
    const proxied = ResolverKit.Make('acme')
    assert.equal(proxied.OriginAllowed('https://acme.admin.example.com', 'acme.admin.example.com:8443'), true)
    assert.equal(proxied.OriginAllowed('https://acme.admin.example.com:8443', 'acme.admin.example.com:8443'), false)
    assert.equal(proxied.OriginAllowed('https://other.admin.example.com', 'acme.admin.example.com'), false)
})

class ConsoleKit
{
    public static Make(externalPort?: number): TenantHostResolver
    {
        return new TenantHostResolver(ResolverKit.Base, ResolverKit.Scheme, new StubDirectory(['acme']) as unknown as PlatformDirectory, externalPort, { host: 'Console-Acme.localtest.me', tenantId: 'acme' })
    }
}

test('console host maps to the seeded tenant', () =>
{
    const r = ConsoleKit.Make()
    assert.equal(r.TenantFor('console-acme.localtest.me'), 'acme')
    assert.equal(r.TenantFor('CONSOLE-ACME.localtest.me:8443'), 'acme')
    assert.equal(r.Accepts('console-acme.localtest.me'), true)
})

test('tenant subdomains still resolve', () =>
{
    assert.equal(ConsoleKit.Make().TenantFor('acme.admin.example.com'), 'acme')
    assert.equal(ConsoleKit.Make().TenantFor('other.localtest.me'), undefined)
})

test('console host with another port is refused when an external port is set', () =>
{
    const r = ConsoleKit.Make(7002)
    assert.equal(r.TenantFor('console-acme.localtest.me:7003'), undefined)
    assert.equal(r.TenantFor('console-acme.localtest.me:7002'), 'acme')
})

test('console host answers nothing when the directory does not know its tenant', () =>
{
    const r = new TenantHostResolver(ResolverKit.Base, ResolverKit.Scheme, new StubDirectory([]) as unknown as PlatformDirectory, undefined, { host: 'console-acme.localtest.me', tenantId: 'acme' })
    assert.equal(r.TenantFor('console-acme.localtest.me'), undefined)
})

test('OriginFor(console host) is the https origin of that host', () =>
{
    assert.equal(ConsoleKit.Make().OriginFor('console-acme.localtest.me'), 'https://console-acme.localtest.me')
})
