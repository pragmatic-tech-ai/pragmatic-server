import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HiveObservationRegistry } from '../hive-observation-record.js'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { FakeProvisioning } from './fake-provisioning.js'
import { RolloutFixture } from './rollout-fixture.js'
import { ControlPlaneHost, type IEnvironmentService, type IGraphService } from '../control-plane-host.js'
import { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import { ClientRegistry } from '../client-registry.js'
import { TenantRegistry } from '../tenant-registry.js'
import { HiveRegistry } from '../hive-registry.js'
import { PlatformDirectory } from '../platform-directory.js'
import type { IOperatorIdentity, OperatorPrincipal, OperatorSession } from '../operator-identity.js'

/**
 * The operator listener's structural isolation: with the tenant plane split onto its own `TenantPlaneHost`, the
 * operator host has no tenant routes at all. A `/tenant-api/*` request is just an unmatched path (operator
 * static/404), never a tenant surface.
 */

type Reply = { status: number; body: string }

enum HttpMethod
{
    Get = 'GET',
}

class FakeOperator implements IOperatorIdentity
{
    public static readonly Email = 'op@example.com'
    public static readonly Password = 'correct-horse'
    public static readonly Token = 'valid-token'

    public async Authenticate(email: string, password: string): Promise<OperatorSession | null>
    {
        return email === FakeOperator.Email && password === FakeOperator.Password
            ? { token: FakeOperator.Token, expiresAt: new Date(Date.now() + 3600000) }
            : null
    }

    public async ValidateToken(token: string): Promise<OperatorPrincipal | null>
    {
        return token === FakeOperator.Token ? { email: FakeOperator.Email, principalId: 'p1' } : null
    }

    public async Revoke(): Promise<void>
    {
    }
}

/** Minimal environment service: only ListReconciled is exercised by the operator route this suite probes. */
class StubEnvironments
{
    public async ListReconciled(): Promise<readonly never[]>
    {
        return []
    }

    public OnChanged(): () => void
    {
        return () => {}
    }
}

class Harness
{
    public static readonly LocalHost = 'localhost'
    public static readonly TenantApiHivesPath = '/tenant-api/hives'
    public static readonly ApiHivesPath = '/api/hives'
    public static readonly ApiEnvironmentsPath = '/api/environments'
    public static readonly HostHeader = 'host'
    public static readonly CookieHeader = 'cookie'
    public static readonly OperatorCookie = 'cp_session=' + FakeOperator.Token
    public static readonly RootPath = '/'

    public static async BuildDirectory(parent: string): Promise<PlatformDirectory>
    {
        return new PlatformDirectory(
            new ClientRegistry(join(parent, 'clients.json')),
            new TenantRegistry(join(parent, 'tenants.json')),
            new HiveRegistry(join(parent, 'hives.json')),
            { List: () => [] })
    }

    public static async Build(parent: string, staticRoot: string): Promise<ControlPlaneHost>
    {
        const directory = await Harness.BuildDirectory(parent)
        const factory = new HiveOrchestratorFactory()
        const host = new ControlPlaneHost(
            new StubEnvironments() as unknown as IEnvironmentService,
            {} as unknown as IGraphService,
            staticRoot,
            new FakeOperator(),
            false,
            directory,
            factory,
            await RolloutFixture.Create(parent, directory, factory),
            new FakeProvisioning(directory).AsService(), new HiveObservationRegistry(join(tmpdir(), 'unused-observations.json')))
        await host.Listen(0, '127.0.0.1')
        return host
    }

    public static Raw(host: ControlPlaneHost, method: string, path: string, headers: Record<string, string>): Promise<Reply>
    {
        const addr = host.Address()
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: addr.address, port: addr.port, method, path, headers }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', c => chunks.push(c as Buffer))
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
            })
            req.on('error', reject)
            req.end()
        })
    }
}

describe('ControlPlaneHost operator-only surface', () =>
{
    let parent: string
    let host: ControlPlaneHost

    beforeEach(async () =>
    {
        parent = mkdtempSync(join(tmpdir(), 'cp-operator-'))
        host = await Harness.Build(parent, join(parent, 'static'))
    })

    afterEach(async () =>
    {
        await host.Close()
        rmSync(parent, { recursive: true, force: true })
    })

    it('answers an operator route 401 without a cookie and 200 with one', async () =>
    {
        const anon = await Harness.Raw(host, HttpMethod.Get, Harness.ApiEnvironmentsPath, { [Harness.HostHeader]: Harness.LocalHost })
        assert.equal(anon.status, 401)
        const authed = await Harness.Raw(host, HttpMethod.Get, Harness.ApiEnvironmentsPath, { [Harness.HostHeader]: Harness.LocalHost, [Harness.CookieHeader]: Harness.OperatorCookie })
        assert.equal(authed.status, 200)
    })

    it('does not route /tenant-api: it is an unmatched operator path (404)', async () =>
    {
        const r = await Harness.Raw(host, HttpMethod.Get, Harness.TenantApiHivesPath, { [Harness.HostHeader]: Harness.LocalHost })
        assert.equal(r.status, 404)
    })

    it('forbids a non-loopback host with 403', async () =>
    {
        const r = await Harness.Raw(host, HttpMethod.Get, Harness.ApiHivesPath, { [Harness.HostHeader]: 'acme.admin.example.com' })
        assert.equal(r.status, 403)
        assert.equal(JSON.parse(r.body).error, 'Host not allowed')
    })
})

describe('ControlPlaneHost static bundle', () =>
{
    const OperatorSentinel = 'OPERATOR-BUNDLE'
    const IndexFile = 'index.html'
    let parent: string
    let host: ControlPlaneHost

    beforeEach(async () =>
    {
        parent = mkdtempSync(join(tmpdir(), 'cp-static-'))
        const operatorRoot = join(parent, 'operator-static')
        mkdirSync(operatorRoot)
        writeFileSync(join(operatorRoot, IndexFile), OperatorSentinel)
        host = await Harness.Build(parent, operatorRoot)
    })

    afterEach(async () =>
    {
        await host.Close()
        rmSync(parent, { recursive: true, force: true })
    })

    it('serves the operator bundle on an operator host', async () =>
    {
        const r = await Harness.Raw(host, HttpMethod.Get, Harness.RootPath, { [Harness.HostHeader]: Harness.LocalHost })
        assert.equal(r.status, 200)
        assert.equal(r.body, OperatorSentinel)
    })
})
