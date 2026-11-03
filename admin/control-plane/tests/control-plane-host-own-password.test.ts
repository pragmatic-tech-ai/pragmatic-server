import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { WebSocket } from 'ws'
import { ControlPlaneHost, type IEnvironmentService, type IGraphService } from '../control-plane-host.js'
import { OperatorIdentity, OperatorRole } from '../operator-identity.js'
import { LoginThrottle } from '../login-throttle.js'
import { AuditRegistry } from '../audit-record.js'
import type { PlatformDirectory } from '../platform-directory.js'
import type { PlatformDeploymentRegistry } from '../platform-deployment-registry.js'
import type { TenantProvisioningService } from '../tenant-provisioning-service.js'
import type { HiveObservationRegistry } from '../hive-observation-record.js'

type Reply = { status: number; body: string; cacheControl?: string; setCookie?: string[]; retryAfter?: string }

class OwnPasswordFixture
{
    public static readonly AdminEmail = 'admin@control-plane.test'
    public static readonly AdminPassword = 'admin-password-initial'
    public static readonly RoEmail = 'ro@control-plane.test'
    public static readonly RoPassword = 'ro-password-initial'
    public static readonly NewPassword = 'ro-password-changed-1'
    public static readonly WrongPassword = 'definitely-not-it'
    public static readonly Path = '/api/session/password'
    public static readonly SessionPath = '/api/session'
    public static readonly CookieName = 'cp_session='
    public static readonly MaxAttempts = 2

    public static Send(host: ControlPlaneHost, method: string, path: string, token: string | undefined, body?: unknown): Promise<Reply>
    {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (token !== undefined)
        {
            headers.cookie = OwnPasswordFixture.CookieName + token
        }
        const addr = host.Address()
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: addr.address, port: addr.port, method, path, headers }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', c => chunks.push(c as Buffer))
                res.on('end', () => resolve({
                    status: res.statusCode ?? 0,
                    body: Buffer.concat(chunks).toString('utf8'),
                    cacheControl: res.headers['cache-control'] as string | undefined,
                    setCookie: res.headers['set-cookie'],
                    retryAfter: res.headers['retry-after'] as string | undefined,
                }))
            })
            req.on('error', reject)
            req.end(body === undefined ? undefined : JSON.stringify(body))
        })
    }

    public static Change(host: ControlPlaneHost, token: string | undefined, currentPassword: string, newPassword: string, confirmPassword?: string): Promise<Reply>
    {
        return OwnPasswordFixture.Send(host, 'POST', OwnPasswordFixture.Path, token, { currentPassword, newPassword, ...(confirmPassword === undefined ? {} : { confirmPassword }) })
    }

    public static TokenFrom(reply: Reply): string
    {
        const cookie = (reply.setCookie ?? []).find(c => c.startsWith(OwnPasswordFixture.CookieName))
        assert.ok(cookie, 'a fresh session cookie is set')
        return cookie.slice(OwnPasswordFixture.CookieName.length).split(';')[0] as string
    }

    public static async SessionStatus(host: ControlPlaneHost, token: string): Promise<number>
    {
        return (await OwnPasswordFixture.Send(host, 'GET', OwnPasswordFixture.SessionPath, token)).status
    }

    public static async Open(host: ControlPlaneHost, token: string): Promise<WebSocket>
    {
        const t = await OwnPasswordFixture.Send(host, 'GET', '/api/events-ticket', token)
        assert.equal(t.status, 200)
        const ticket = (JSON.parse(t.body) as { ticket: string }).ticket
        const ws = new WebSocket(`ws://127.0.0.1:${host.Address().port}/api/events`, [ticket])
        await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej) })
        // Admission re-validates inside the handshake; give it a moment to register the socket.
        await new Promise(res => setTimeout(res, 50))
        return ws
    }

    public static async ClosedSoon(ws: WebSocket): Promise<boolean>
    {
        if (ws.readyState === WebSocket.CLOSED)
        {
            return true
        }
        return await new Promise<boolean>(res =>
        {
            const timer = setTimeout(() => res(false), 500)
            ws.once('close', () => { clearTimeout(timer); res(true) })
        })
    }
}

describe('ControlPlaneHost own password change + operator reset session cut', () =>
{
    let root: string
    let host: ControlPlaneHost
    let identity: OperatorIdentity
    let audit: AuditRegistry
    let logged: string[]
    let originalError: typeof console.error
    let originalLog: typeof console.log

    beforeEach(async () =>
    {
        root = mkdtempSync(join(tmpdir(), 'cp-own-pw-'))
        identity = await OperatorIdentity.Compose({ identityRoot: join(root, 'identity'), masterKeyFile: join(root, 'master.key'), operatorEmail: OwnPasswordFixture.AdminEmail, initialPassword: OwnPasswordFixture.AdminPassword })
        await identity.CreateOperator(OwnPasswordFixture.RoEmail, OwnPasswordFixture.RoPassword, OperatorRole.ReadOnly)
        audit = new AuditRegistry(join(root, 'audit.json'))
        await audit.Load()
        const service = { OnChanged: () => () => undefined } as unknown as IEnvironmentService
        host = new ControlPlaneHost(service, {} as IGraphService, root, identity, false,
            {} as PlatformDirectory, {} as PlatformDeploymentRegistry, {} as TenantProvisioningService, {} as HiveObservationRegistry,
            new LoginThrottle({ maxAttempts: OwnPasswordFixture.MaxAttempts }), false, undefined, undefined, undefined, [], undefined, audit)
        await host.Listen(0, '127.0.0.1')
        logged = []
        originalError = console.error
        originalLog = console.log
        console.error = (...args: unknown[]) => { logged.push(args.map(a => String(a)).join(' ')) }
        console.log = (...args: unknown[]) => { logged.push(args.map(a => String(a)).join(' ')) }
    })

    afterEach(async () =>
    {
        console.error = originalError
        console.log = originalLog
        await host.Close()
        rmSync(root, { recursive: true, force: true })
    })

    it('a read-only operator changes their own password: the caller stays signed in on a fresh cookie, every other session and socket of theirs ends', async () =>
    {
        const mine = (await identity.Authenticate(OwnPasswordFixture.RoEmail, OwnPasswordFixture.RoPassword))!.token
        const elsewhere = (await identity.Authenticate(OwnPasswordFixture.RoEmail, OwnPasswordFixture.RoPassword))!.token
        const admin = (await identity.Authenticate(OwnPasswordFixture.AdminEmail, OwnPasswordFixture.AdminPassword))!.token
        const mySocket = await OwnPasswordFixture.Open(host, mine)
        const elsewhereSocket = await OwnPasswordFixture.Open(host, elsewhere)
        const adminSocket = await OwnPasswordFixture.Open(host, admin)

        const r = await OwnPasswordFixture.Change(host, mine, OwnPasswordFixture.RoPassword, OwnPasswordFixture.NewPassword, OwnPasswordFixture.NewPassword)
        assert.equal(r.status, 200, r.body)
        assert.equal(r.cacheControl, 'no-store')
        const fresh = OwnPasswordFixture.TokenFrom(r)
        assert.notEqual(fresh, mine)
        assert.equal(await OwnPasswordFixture.SessionStatus(host, fresh), 200)
        assert.equal(await OwnPasswordFixture.SessionStatus(host, mine), 401)
        assert.equal(await OwnPasswordFixture.SessionStatus(host, elsewhere), 401)
        assert.equal(await OwnPasswordFixture.SessionStatus(host, admin), 200)

        assert.equal(await OwnPasswordFixture.ClosedSoon(elsewhereSocket), true, 'the other session socket closes')
        assert.equal(mySocket.readyState, WebSocket.OPEN, 'the caller socket stays open')
        assert.equal(adminSocket.readyState, WebSocket.OPEN, 'another operator socket stays open')

        assert.equal(await identity.Authenticate(OwnPasswordFixture.RoEmail, OwnPasswordFixture.RoPassword), null)
        assert.ok(await identity.Authenticate(OwnPasswordFixture.RoEmail, OwnPasswordFixture.NewPassword))

        const entry = audit.Recent(10).find(e => e.path === OwnPasswordFixture.Path)
        assert.equal(entry?.status, 200)
        assert.equal(entry?.actor, OwnPasswordFixture.RoEmail)
        const everything = JSON.stringify(audit.Recent(100)) + r.body + logged.join('\n')
        assert.ok(!everything.includes(OwnPasswordFixture.NewPassword))
        assert.ok(!everything.includes(OwnPasswordFixture.RoPassword))

        // The caller's socket was moved to the fresh token: a later sweep must not close it.
        mySocket.close()
        adminSocket.close()
    })

    it('a wrong current password is a 403 with a generic message; nothing changes and no session ends', async () =>
    {
        const mine = (await identity.Authenticate(OwnPasswordFixture.RoEmail, OwnPasswordFixture.RoPassword))!.token
        const r = await OwnPasswordFixture.Change(host, mine, OwnPasswordFixture.WrongPassword, OwnPasswordFixture.NewPassword)
        assert.equal(r.status, 403)
        assert.equal(r.cacheControl, 'no-store')
        assert.equal((JSON.parse(r.body) as { error: string }).error, 'The current password is not correct.')
        assert.equal(r.setCookie, undefined)
        assert.equal(await OwnPasswordFixture.SessionStatus(host, mine), 200)
        assert.ok(await identity.Authenticate(OwnPasswordFixture.RoEmail, OwnPasswordFixture.RoPassword))
        assert.ok(!r.body.includes(OwnPasswordFixture.WrongPassword))
        assert.equal(audit.Recent(10).find(e => e.path === OwnPasswordFixture.Path)?.status, 403)
    })

    it('a short, mismatched, unchanged or missing new password is a 400 and nothing changes', async () =>
    {
        const mine = (await identity.Authenticate(OwnPasswordFixture.RoEmail, OwnPasswordFixture.RoPassword))!.token
        const shortReply = await OwnPasswordFixture.Change(host, mine, OwnPasswordFixture.RoPassword, 'too-short')
        assert.equal(shortReply.status, 400)
        assert.match(shortReply.body, /at least 12 characters/)
        assert.equal(shortReply.cacheControl, 'no-store')
        const mismatch = await OwnPasswordFixture.Change(host, mine, OwnPasswordFixture.RoPassword, OwnPasswordFixture.NewPassword, 'something-else-entirely')
        assert.equal(mismatch.status, 400)
        assert.match(mismatch.body, /do not match/)
        const same = await OwnPasswordFixture.Change(host, mine, OwnPasswordFixture.RoPassword, OwnPasswordFixture.RoPassword)
        assert.equal(same.status, 400)
        assert.match(same.body, /must differ/)
        const missing = await OwnPasswordFixture.Send(host, 'POST', OwnPasswordFixture.Path, mine, { newPassword: OwnPasswordFixture.NewPassword })
        assert.equal(missing.status, 400)
        assert.equal(await OwnPasswordFixture.SessionStatus(host, mine), 200)
        assert.ok(await identity.Authenticate(OwnPasswordFixture.RoEmail, OwnPasswordFixture.RoPassword))
    })

    it('wrong current passwords are throttled like login: 429 with Retry-After, even for the right password, once locked', async () =>
    {
        const mine = (await identity.Authenticate(OwnPasswordFixture.RoEmail, OwnPasswordFixture.RoPassword))!.token
        for (let i = 0; i < OwnPasswordFixture.MaxAttempts; i++)
        {
            assert.equal((await OwnPasswordFixture.Change(host, mine, OwnPasswordFixture.WrongPassword, OwnPasswordFixture.NewPassword)).status, 403)
        }
        const locked = await OwnPasswordFixture.Change(host, mine, OwnPasswordFixture.RoPassword, OwnPasswordFixture.NewPassword)
        assert.equal(locked.status, 429)
        assert.match(locked.retryAfter ?? '', /^\d+$/)
        assert.equal(locked.cacheControl, 'no-store')
        assert.ok(await identity.Authenticate(OwnPasswordFixture.RoEmail, OwnPasswordFixture.RoPassword))
    })

    it('without a session the change is a 401', async () =>
    {
        const r = await OwnPasswordFixture.Change(host, undefined, OwnPasswordFixture.RoPassword, OwnPasswordFixture.NewPassword)
        assert.equal(r.status, 401)
        const forged = await OwnPasswordFixture.Change(host, 'not-a-session', OwnPasswordFixture.RoPassword, OwnPasswordFixture.NewPassword)
        assert.equal(forged.status, 401)
        assert.ok(await identity.Authenticate(OwnPasswordFixture.RoEmail, OwnPasswordFixture.RoPassword))
    })

    it('an operator reset of another operator ends all of their sessions and closes their sockets; the resetting operator stays signed in', async () =>
    {
        const target = (await identity.Authenticate(OwnPasswordFixture.RoEmail, OwnPasswordFixture.RoPassword))!.token
        const admin = (await identity.Authenticate(OwnPasswordFixture.AdminEmail, OwnPasswordFixture.AdminPassword))!.token
        const targetSocket = await OwnPasswordFixture.Open(host, target)
        const adminSocket = await OwnPasswordFixture.Open(host, admin)
        const r = await OwnPasswordFixture.Send(host, 'POST', '/api/operators/password-reset', admin, { email: OwnPasswordFixture.RoEmail })
        assert.equal(r.status, 200)
        assert.equal(r.cacheControl, 'no-store')
        assert.equal(await OwnPasswordFixture.SessionStatus(host, target), 401)
        assert.equal(await OwnPasswordFixture.ClosedSoon(targetSocket), true)
        assert.equal(await OwnPasswordFixture.SessionStatus(host, admin), 200)
        assert.equal(adminSocket.readyState, WebSocket.OPEN)
        adminSocket.close()
    })

    it('an operator who resets their OWN password through the operator reset is signed out too (the reset is not self-exempt; the new password is still returned once)', async () =>
    {
        const admin = (await identity.Authenticate(OwnPasswordFixture.AdminEmail, OwnPasswordFixture.AdminPassword))!.token
        const r = await OwnPasswordFixture.Send(host, 'POST', '/api/operators/password-reset', admin, { email: OwnPasswordFixture.AdminEmail })
        assert.equal(r.status, 200)
        const password = (JSON.parse(r.body) as { password: string }).password
        assert.ok(password.length >= 12)
        assert.equal(await OwnPasswordFixture.SessionStatus(host, admin), 401)
        assert.ok(await identity.Authenticate(OwnPasswordFixture.AdminEmail, password))
    })
})
