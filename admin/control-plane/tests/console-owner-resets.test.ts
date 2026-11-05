import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConsoleOwnerResets } from '../console-owner-resets.js'
import { ConsoleOwnerResetFollower, type IOwnerSessionEnder } from '../console-owner-reset-follower.js'
import { TenantOwner, type OwnedTenant } from '../tenant-owner.js'
import { TenantProvisioningService } from '../tenant-provisioning-service.js'
import { TenantPrincipalSessions, type IPrincipalConnections } from '../tenant-auth/tenant-principal-sessions.js'
import { TenantSessionKind, TenantSessionStore } from '../tenant-auth/tenant-session.js'

class Names
{
    public static readonly TempPrefix = 'console-owner-resets-'
    public static readonly Tenant = 'acme'
    public static readonly OtherTenant = 'beta'
    public static readonly Principal = 'p-1'
    public static readonly Reset = '2026-11-04T10:00:00.000Z'
    public static readonly LaterReset = '2026-11-04T11:00:00.000Z'
    public static readonly EarlierReset = '2026-11-03T09:00:00.000Z'
    public static readonly Utf8 = 'utf8'
    public static readonly TempSuffix = '.tmp'
    public static readonly StoreFailure = 'disk full'
    public static readonly SessionsFile = 'tenant-sessions.json'
    public static readonly OwnerEmail = 'owner@acme.test'
    public static readonly HourMs = 60 * 60 * 1000
}

/** Records every revoke; can be made to fail once. */
class FakeSessions implements IOwnerSessionEnder
{
    public readonly Calls: Array<[string, string]> = []
    public FailNext = false

    public async RevokeAllFor(tenantId: string, principalId: string): Promise<void>
    {
        this.Calls.push([tenantId, principalId])
        if (this.FailNext)
        {
            this.FailNext = false
            throw new Error(Names.StoreFailure)
        }
    }
}

/** A connection registry counting the principal closes (the tenant plane's sockets, or the desktop relay). */
class CountingConnections implements IPrincipalConnections
{
    public readonly Closed: Array<[string, string]> = []

    public ClosePrincipal(tenantId: string, principalId: string): number
    {
        this.Closed.push([tenantId, principalId])
        return 1
    }

    public MoveSession(): void
    {
    }

    public CloseTenant(): number
    {
        return 0
    }
}

describe('ConsoleOwnerResets', () =>
{
    let root = ''

    beforeEach(() =>
    {
        root = mkdtempSync(join(tmpdir(), Names.TempPrefix))
    })

    afterEach(() =>
    {
        rmSync(root, { recursive: true, force: true })
    })

    const path = (): string => join(root, ConsoleOwnerResets.FileName)

    it('Record stores the reset time per tenant and survives a reload', async () =>
    {
        const store = new ConsoleOwnerResets(path(), () => new Date(Names.Reset))
        await store.Load()
        assert.equal(await store.Record(Names.Tenant), Names.Reset)
        assert.equal(store.Of(Names.Tenant), Names.Reset)
        assert.equal(store.Of(Names.OtherTenant), undefined)
        const reloaded = new ConsoleOwnerResets(path())
        await reloaded.Load()
        assert.equal(reloaded.Of(Names.Tenant), Names.Reset)
    })

    it('a missing file is empty and Load never writes', async () =>
    {
        const store = new ConsoleOwnerResets(path())
        await store.Load()
        assert.equal(store.Of(Names.Tenant), undefined)
        assert.equal(existsSync(path()), false)
    })

    it('a malformed file fails Load naming the file', async () =>
    {
        writeFileSync(path(), '{"acme": 5}')
        await assert.rejects(() => new ConsoleOwnerResets(path()).Load(), (err: unknown) => err instanceof Error && err.message.includes(path()))
    })

    it('a second reset in the same millisecond still records a different value', async () =>
    {
        const store = new ConsoleOwnerResets(path(), () => new Date(Names.Reset))
        await store.Load()
        const first = await store.Record(Names.Tenant)
        const second = await store.Record(Names.Tenant)
        assert.notEqual(second, first)
        assert.equal(Date.parse(second) - Date.parse(first), 1)
        assert.equal(store.Of(Names.Tenant), second)
    })

    it('Forget drops the tenant', async () =>
    {
        const store = new ConsoleOwnerResets(path(), () => new Date(Names.Reset))
        await store.Load()
        await store.Record(Names.Tenant)
        await store.Record(Names.OtherTenant)
        await store.Forget(Names.Tenant)
        assert.equal(store.Of(Names.Tenant), undefined)
        assert.equal(store.Of(Names.OtherTenant), Names.Reset)
        const reloaded = new ConsoleOwnerResets(path())
        await reloaded.Load()
        assert.equal(reloaded.Of(Names.Tenant), undefined)
        assert.equal(reloaded.Of(Names.OtherTenant), Names.Reset)
        await store.Forget('never-reset')
    })

    it('two concurrent Records of different tenants both persist and leave no temp file', async () =>
    {
        const store = new ConsoleOwnerResets(path(), () => new Date(Names.Reset))
        await store.Load()
        await Promise.all([store.Record(Names.Tenant), store.Record(Names.OtherTenant), store.Forget('nobody')])
        const onDisk = JSON.parse(readFileSync(path(), Names.Utf8)) as Record<string, string>
        assert.deepEqual(onDisk, { [Names.Tenant]: Names.Reset, [Names.OtherTenant]: Names.Reset })
        assert.deepEqual(readdirSync(root).filter(f => f.endsWith(Names.TempSuffix)), [])
    })
})

describe('TenantOwner', () =>
{
    it('names the recorded Owner principal, or the default one; the provisioning constant is the same rule', () =>
    {
        assert.equal(TenantOwner.PrincipalOf({ ownerPrincipalId: Names.Principal }), Names.Principal)
        assert.equal(TenantOwner.PrincipalOf({}), TenantOwner.DefaultPrincipalId)
        assert.equal(TenantProvisioningService.OwnerPrincipalId, TenantOwner.DefaultPrincipalId)
    })
})

describe('ConsoleOwnerResetFollower', () =>
{
    let root = ''
    let sessions: FakeSessions

    beforeEach(() =>
    {
        root = mkdtempSync(join(tmpdir(), Names.TempPrefix))
        sessions = new FakeSessions()
    })

    afterEach(() =>
    {
        rmSync(root, { recursive: true, force: true })
    })

    const marker = (): string => join(root, ConsoleOwnerResetFollower.FileName)
    const follower = (tenant: OwnedTenant = { id: Names.Tenant, ownerPrincipalId: Names.Principal }): ConsoleOwnerResetFollower =>
        new ConsoleOwnerResetFollower(sessions, tenant, marker())

    it('Apply revokes the Owner once per reset', async () =>
    {
        const f = follower()
        assert.equal(await f.Apply(Names.Reset), true)
        assert.deepEqual(sessions.Calls, [[Names.Tenant, Names.Principal]])
        assert.equal(await f.Apply(Names.Reset), false)
        assert.equal(sessions.Calls.length, 1)
        assert.equal(await f.Apply(Names.LaterReset), true)
        assert.equal(sessions.Calls.length, 2)
        assert.deepEqual(JSON.parse(readFileSync(marker(), Names.Utf8)), { appliedAt: Names.LaterReset })
    })

    it('Apply without ownerPrincipalId revokes the default owner principal', async () =>
    {
        assert.equal(await follower({ id: Names.Tenant }).Apply(Names.Reset), true)
        assert.deepEqual(sessions.Calls, [[Names.Tenant, TenantOwner.DefaultPrincipalId]])
    })

    it('Apply ignores undefined and malformed values', async () =>
    {
        const f = follower()
        for (const value of [undefined, '', 'not a time', '2026-13-45T99:00:00Z'])
        {
            assert.equal(await f.Apply(value), false, String(value))
        }
        assert.deepEqual(sessions.Calls, [])
        assert.equal(existsSync(marker()), false)
    })

    it('an equal value is a no-op; a different value revokes, even an earlier one', async () =>
    {
        const f = follower()
        assert.equal(await f.Apply(Names.Reset), true)
        assert.equal(await f.Apply(Names.Reset), false)
        assert.equal(await f.Apply(Names.EarlierReset), true, 'a control-plane clock moved back still ends the sessions')
        assert.equal(sessions.Calls.length, 2)
    })

    it('the applied marker survives a restart', async () =>
    {
        assert.equal(await follower().Apply(Names.Reset), true)
        assert.equal(await follower().Apply(Names.Reset), false)
        assert.equal(sessions.Calls.length, 1)
    })

    it('a failed revoke writes no marker and the next advert retries', async () =>
    {
        const f = follower()
        sessions.FailNext = true
        await assert.rejects(() => f.Apply(Names.Reset))
        assert.equal(existsSync(marker()), false)
        assert.equal(await f.Apply(Names.Reset), true)
        assert.equal(sessions.Calls.length, 2)
        assert.deepEqual(JSON.parse(readFileSync(marker(), Names.Utf8)), { appliedAt: Names.Reset })
    })

    it('an unreadable marker counts as none (one extra revoke, never a missed one)', async () =>
    {
        writeFileSync(marker(), 'not json')
        assert.equal(await follower().Apply(Names.Reset), true)
        assert.equal(sessions.Calls.length, 1)
    })

    it('ends the Owner console and desktop sessions and closes its sockets and relays, keeping other principals', async () =>
    {
        let now = new Date(Names.EarlierReset)
        const store = new TenantSessionStore(join(root, Names.SessionsFile), Names.HourMs, () => now)
        const principals = new TenantPrincipalSessions(store)
        const sockets = new CountingConnections()
        const relays = new CountingConnections()
        principals.Attach(sockets)
        principals.Attach(relays)
        const browser = await store.Issue(Names.Tenant, Names.Principal, Names.OwnerEmail)
        const desktop = await store.Issue(Names.Tenant, Names.Principal, Names.OwnerEmail, TenantSessionKind.Desktop)
        const other = await store.Issue(Names.Tenant, 'someone-else')
        now = new Date(Date.parse(Names.EarlierReset) + 1000)
        const f = new ConsoleOwnerResetFollower(principals, { id: Names.Tenant, ownerPrincipalId: Names.Principal }, marker())
        assert.equal(await f.Apply(Names.Reset), true)
        assert.equal(await store.Validate(browser.id), null)
        assert.equal(await store.Validate(desktop.id), null)
        assert.notEqual(await store.Validate(other.id), null)
        assert.deepEqual(sockets.Closed, [[Names.Tenant, Names.Principal]])
        assert.deepEqual(relays.Closed, [[Names.Tenant, Names.Principal]])
    })
})
