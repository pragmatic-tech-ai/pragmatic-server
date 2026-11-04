import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { TenantSessionKind, TenantSessionStore } from '../tenant-auth/tenant-session.js'
import { TenantSessionCookie } from '../tenant-auth/tenant-session-cookie.js'
import { DesktopAuthGate } from '../tenant-auth/desktop-auth-gate.js'
import type { TenantRecord } from '../platform-records.js'

/** Fixtures + a fake request for driving DesktopAuthGate against a real file-backed session store. */
class DesktopGateFixture
{
    public static readonly Prefix = 'desktopgate-'
    public static readonly FileName = 'sessions.json'
    public static readonly Tenant = 'acme-prod'
    public static readonly Principal = 'user-1'
    public static readonly Ttl = 60000

    public static async WithStore(body: (store: TenantSessionStore) => Promise<void>): Promise<void>
    {
        const dir = await mkdtemp(join(tmpdir(), DesktopGateFixture.Prefix))
        try
        {
            await body(new TenantSessionStore(join(dir, DesktopGateFixture.FileName), DesktopGateFixture.Ttl))
        }
        finally
        {
            await rm(dir, { recursive: true, force: true })
        }
    }

    public static Req(headers: Record<string, string>): IncomingMessage
    {
        return { headers } as unknown as IncomingMessage
    }
}

test('DesktopAuthGate returns the session for a desktop bearer token', async () =>
{
    await DesktopGateFixture.WithStore(async store =>
    {
        const desktop = await store.Issue(DesktopGateFixture.Tenant, DesktopGateFixture.Principal, undefined, TenantSessionKind.Desktop)
        const session = await new DesktopAuthGate(store).Principal(DesktopGateFixture.Req({ authorization: `Bearer ${desktop.id}` }))
        assert.equal(session?.id, desktop.id)
        assert.equal(session?.principalId, DesktopGateFixture.Principal)
    })
})

test('DesktopAuthGate refuses a console token as bearer', async () =>
{
    await DesktopGateFixture.WithStore(async store =>
    {
        const consoleSession = await store.Issue(DesktopGateFixture.Tenant, DesktopGateFixture.Principal)
        assert.equal(await new DesktopAuthGate(store).Principal(DesktopGateFixture.Req({ authorization: `Bearer ${consoleSession.id}` })), null)
    })
})

test('DesktopAuthGate refuses a missing or non-Bearer header and ignores cookies', async () =>
{
    await DesktopGateFixture.WithStore(async store =>
    {
        const desktop = await store.Issue(DesktopGateFixture.Tenant, DesktopGateFixture.Principal, undefined, TenantSessionKind.Desktop)
        const gate = new DesktopAuthGate(store)
        assert.equal(await gate.Principal(DesktopGateFixture.Req({})), null)
        assert.equal(await gate.Principal(DesktopGateFixture.Req({ authorization: `Basic ${desktop.id}` })), null)
        assert.equal(await gate.Principal(DesktopGateFixture.Req({ authorization: 'Bearer' })), null)
        const cookie = `${TenantSessionCookie.Name}=${encodeURIComponent(DesktopGateFixture.Tenant)}.${desktop.id}`
        assert.equal(await gate.Principal(DesktopGateFixture.Req({ cookie })), null)
    })
})

test('DesktopAuthGate refuses a revoked desktop token', async () =>
{
    await DesktopGateFixture.WithStore(async store =>
    {
        const desktop = await store.Issue(DesktopGateFixture.Tenant, DesktopGateFixture.Principal, undefined, TenantSessionKind.Desktop)
        await store.Revoke(desktop.id)
        assert.equal(await new DesktopAuthGate(store).Principal(DesktopGateFixture.Req({ authorization: `Bearer ${desktop.id}` })), null)
    })
})

class GateTenants
{
    public readonly records = new Map<string, TenantRecord>()

    public GetTenant(id: string): TenantRecord | undefined
    {
        return this.records.get(id)
    }

    public Put(id: string, createdAt: string): void
    {
        this.records.set(id, { id, clientId: 'c1', displayName: id, createdAt })
    }
}

test('DesktopAuthGate with tenant records refuses a session whose tenant is gone or was re-created after it was issued', async () =>
{
    await DesktopGateFixture.WithStore(async store =>
    {
        const tenants = new GateTenants()
        tenants.Put(DesktopGateFixture.Tenant, '2026-01-01T00:00:00.000Z')
        const gate = new DesktopAuthGate(store, tenants)
        const desktop = await store.Issue(DesktopGateFixture.Tenant, DesktopGateFixture.Principal, undefined, TenantSessionKind.Desktop)
        const req = DesktopGateFixture.Req({ authorization: `Bearer ${desktop.id}` })
        assert.equal((await gate.Principal(req))?.id, desktop.id)
        tenants.records.delete(DesktopGateFixture.Tenant)
        assert.equal(await gate.Principal(req), null, 'tenant record missing')
        tenants.Put(DesktopGateFixture.Tenant, new Date(Date.now() + 60000).toISOString())
        assert.equal(await gate.Principal(req), null, 'tenant re-created after the session was issued')
        tenants.Put(DesktopGateFixture.Tenant, 'not-a-date')
        assert.equal(await gate.Principal(req), null, 'unreadable creation time fails closed')
    })
})
