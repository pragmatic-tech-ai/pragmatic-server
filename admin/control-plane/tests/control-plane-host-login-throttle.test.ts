import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { ControlPlaneHost } from '../control-plane-host.js'
import type { IEnvironmentService, IGraphService } from '../control-plane-host.js'
import { LoginThrottle } from '../login-throttle.js'
import type { LoginThrottleDecision } from '../login-throttle.js'
import { OperatorRole, type IOperatorIdentity, type OperatorPrincipal, type OperatorSession, type OperatorSummary } from '../operator-identity.js'
import type { PlatformDirectory } from '../platform-directory.js'
import type { PlatformDeploymentRegistry } from '../platform-deployment-registry.js'
import type { TenantProvisioningService } from '../tenant-provisioning-service.js'
import type { HiveObservationRegistry } from '../hive-observation-record.js'

type Reply = { status: number; retryAfter: string | undefined }

class CountingOperator implements IOperatorIdentity
{
    public Calls = 0
    public Succeed = false

    public async Authenticate(_email: string, _password: string): Promise<OperatorSession | null>
    {
        this.Calls++
        return this.Succeed ? { token: 't', expiresAt: new Date(Date.now() + Fixture.CookieMs) } : null
    }

    public async ValidateToken(_token: string): Promise<OperatorPrincipal | null>
    {
        return null
    }

    public async ListOperators(): Promise<readonly OperatorSummary[]>
    {
        return []
    }

    public async CreateOperator(_email: string, _password: string, _role: OperatorRole): Promise<void>
    {
    }

    public async Revoke(_token: string): Promise<void>
    {
    }
}

class SpyThrottle extends LoginThrottle
{
    public readonly Ips: string[] = []

    public override CheckAllowed(email: string, ip: string): LoginThrottleDecision
    {
        this.Ips.push(ip)
        return super.CheckAllowed(email, ip)
    }
}

class Fixture
{
    public static readonly Email = 'op@example.com'
    public static readonly Max = 3
    public static readonly Forged = '6.6.6.6'
    public static readonly Hop = '9.9.9.9'
    public static readonly Loopback = '127.0.0.1'
    public static readonly ForwardedFor = 'x-forwarded-for'
    public static readonly Unauthorized = 401
    public static readonly TooMany = 429
    public static readonly Ok = 200
    public static readonly BurstFactor = 3
    public static readonly CookieMs = 3600000

    public static Login(host: ControlPlaneHost, headers: Record<string, string> = {}): Promise<Reply>
    {
        const addr = host.Address()
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: addr.address, port: addr.port, method: 'POST', path: '/api/login', headers: { 'content-type': 'application/json', ...headers } }, res =>
            {
                res.resume()
                res.on('end', () => resolve({ status: res.statusCode ?? 0, retryAfter: res.headers['retry-after'] as string | undefined }))
            })
            req.on('error', reject)
            req.end(JSON.stringify({ email: Fixture.Email, password: 'bad' }))
        })
    }
}

describe('ControlPlaneHost login throttling', () =>
{
    let root: string
    let host: ControlPlaneHost
    let operator: CountingOperator
    let throttle: SpyThrottle

    async function Start(trustedProxy: boolean): Promise<void>
    {
        host = new ControlPlaneHost({} as IEnvironmentService, {} as IGraphService, root, operator, false,
            {} as PlatformDirectory, {} as PlatformDeploymentRegistry, {} as TenantProvisioningService, {} as HiveObservationRegistry, throttle, trustedProxy)
        await host.Listen(0, Fixture.Loopback)
    }

    beforeEach(() =>
    {
        root = mkdtempSync(join(tmpdir(), 'cp-throttle-'))
        operator = new CountingOperator()
        throttle = new SpyThrottle({ maxAttempts: Fixture.Max })
    })

    afterEach(async () =>
    {
        await host.Close()
        rmSync(root, { recursive: true, force: true })
    })

    it('answers 429 with a numeric Retry-After and never calls Authenticate once locked', async () =>
    {
        await Start(false)
        for (let i = 0; i < Fixture.Max; i++)
        {
            assert.equal((await Fixture.Login(host)).status, Fixture.Unauthorized)
        }
        const calls = operator.Calls
        const locked = await Fixture.Login(host)
        assert.equal(locked.status, Fixture.TooMany)
        assert.ok(Number(locked.retryAfter) > 0)
        assert.equal(operator.Calls, calls)
    })

    it('lets only maxAttempts of a parallel burst reach Authenticate', async () =>
    {
        await Start(false)
        const replies = await Promise.all(Array.from({ length: Fixture.Max * Fixture.BurstFactor }, () => Fixture.Login(host)))
        assert.equal(operator.Calls, Fixture.Max)
        assert.equal(replies.filter(r => r.status === Fixture.TooMany).length, Fixture.Max * (Fixture.BurstFactor - 1))
    })

    it('a success clears the optimistic count', async () =>
    {
        await Start(false)
        await Fixture.Login(host)
        operator.Succeed = true
        assert.equal((await Fixture.Login(host)).status, Fixture.Ok)
        operator.Succeed = false
        for (let i = 0; i < Fixture.Max; i++)
        {
            assert.equal((await Fixture.Login(host)).status, Fixture.Unauthorized)
        }
    })

    it('ignores a forged x-forwarded-for when trustedProxy is off', async () =>
    {
        await Start(false)
        await Fixture.Login(host, { [Fixture.ForwardedFor]: Fixture.Forged })
        assert.equal(throttle.Ips.length, 1)
        assert.ok(!throttle.Ips[0].includes(Fixture.Forged))
        assert.ok(throttle.Ips[0].includes(Fixture.Loopback))
    })

    it('uses the last x-forwarded-for hop when trustedProxy is on', async () =>
    {
        await Start(true)
        await Fixture.Login(host, { [Fixture.ForwardedFor]: Fixture.Forged + ', ' + Fixture.Hop })
        assert.deepEqual(throttle.Ips, [Fixture.Hop])
    })
})
