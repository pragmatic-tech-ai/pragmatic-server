import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { TenantSessionStore } from '../tenant-auth/tenant-session.js'
import { TenantSessionCookie } from '../tenant-auth/tenant-session-cookie.js'
import { TenantAuthGate } from '../tenant-auth/tenant-auth-gate.js'

/** Fixtures + a clock + a fake request for driving TenantAuthGate against a real file-backed session store. */
class GateFixture
{
    public static readonly Prefix = 'tenantgate-'
    public static readonly FileName = 'sessions.json'
    public static readonly Tenant = 'acme-prod'
    public static readonly Principal = 'user-1'
    public static readonly Email = 'a@acme.test'
    public static readonly Ttl = 60000
    public static readonly Start = 1_000_000
    private static readonly PairSeparator = '='
    private static readonly TenantTokenSeparator = '.'

    public static async WithDir(body: (file: string) => Promise<void>): Promise<void>
    {
        const dir = await mkdtemp(join(tmpdir(), GateFixture.Prefix))
        try
        {
            await body(join(dir, GateFixture.FileName))
        }
        finally
        {
            await rm(dir, { recursive: true, force: true })
        }
    }

    public static Req(cookie?: string): IncomingMessage
    {
        const headers = cookie === undefined ? {} : { cookie }
        return { headers } as unknown as IncomingMessage
    }

    public static Cookie(tenantId: string, token: string): string
    {
        return TenantSessionCookie.Name + GateFixture.PairSeparator
            + encodeURIComponent(tenantId) + GateFixture.TenantTokenSeparator + token
    }
}

test('Principal returns the session for a valid pts_session cookie', async () =>
{
    await GateFixture.WithDir(async file =>
    {
        const store = new TenantSessionStore(file, GateFixture.Ttl)
        const issued = await store.Issue(GateFixture.Tenant, GateFixture.Principal, GateFixture.Email)
        const gate = new TenantAuthGate(store)
        const session = await gate.Principal(GateFixture.Req(GateFixture.Cookie(GateFixture.Tenant, issued.id)))
        assert.notEqual(session, null)
        assert.equal(session?.tenantId, GateFixture.Tenant)
        assert.equal(session?.principalId, GateFixture.Principal)
    })
})

test('Principal returns null when there is no cookie', async () =>
{
    await GateFixture.WithDir(async file =>
    {
        const store = new TenantSessionStore(file, GateFixture.Ttl)
        const gate = new TenantAuthGate(store)
        assert.equal(await gate.Principal(GateFixture.Req()), null)
    })
})

test('Principal returns null for an expired session', async () =>
{
    await GateFixture.WithDir(async file =>
    {
        let nowMs = GateFixture.Start
        const store = new TenantSessionStore(file, GateFixture.Ttl, () => new Date(nowMs))
        const issued = await store.Issue(GateFixture.Tenant, GateFixture.Principal)
        const gate = new TenantAuthGate(store)
        nowMs = GateFixture.Start + GateFixture.Ttl + 1
        assert.equal(await gate.Principal(GateFixture.Req(GateFixture.Cookie(GateFixture.Tenant, issued.id))), null)
    })
})

test('Principal returns null after the session is revoked', async () =>
{
    await GateFixture.WithDir(async file =>
    {
        const store = new TenantSessionStore(file, GateFixture.Ttl)
        const issued = await store.Issue(GateFixture.Tenant, GateFixture.Principal)
        const gate = new TenantAuthGate(store)
        await store.Revoke(issued.id)
        assert.equal(await gate.Principal(GateFixture.Req(GateFixture.Cookie(GateFixture.Tenant, issued.id))), null)
    })
})

test('Principal returns null when the cookie tenant does not match the session tenant', async () =>
{
    await GateFixture.WithDir(async file =>
    {
        const store = new TenantSessionStore(file, GateFixture.Ttl)
        const issued = await store.Issue(GateFixture.Tenant, GateFixture.Principal)
        const gate = new TenantAuthGate(store)
        assert.equal(await gate.Principal(GateFixture.Req(GateFixture.Cookie('other-tenant', issued.id))), null)
    })
})
