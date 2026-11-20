import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { FakeProvisioning } from './fake-provisioning.js'
import { RolloutFixture } from './rollout-fixture.js'
import { ControlPlaneHost, type IEnvironmentService, type IGraphService } from '../control-plane-host.js'
import { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import { ClientRegistry } from '../client-registry.js'
import { TenantRegistry } from '../tenant-registry.js'
import { HiveRegistry } from '../hive-registry.js'
import { PlatformDirectory } from '../platform-directory.js'
import { OperatorRole, type IOperatorIdentity, type OperatorPrincipal, type OperatorSummary } from '../operator-identity.js'
import { HostSessions } from './host-sessions.js'

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
    public static readonly PrincipalId = 'p1'

    /** The operator the planted session names. */
    public static Principal(): OperatorPrincipal
    {
        return { email: FakeOperator.Email, principalId: FakeOperator.PrincipalId, role: OperatorRole.Full }
    }

    public async Verify(email: string, password: string): Promise<OperatorPrincipal | null>
    {
        return email === FakeOperator.Email && password === FakeOperator.Password
            ? { email, principalId: FakeOperator.PrincipalId, role: OperatorRole.Full }
            : null
    }

    public async PrincipalOf(principalId: string): Promise<OperatorPrincipal | null>
    {
        return { email: FakeOperator.Email, principalId, role: OperatorRole.Full }
    }

    public async ListOperators(): Promise<readonly OperatorSummary[]>
    {
        return []
    }

    public async SetOperatorRole(_email: string, _role: OperatorRole, _actorPrincipalId: string): Promise<void>
    {
    }

    public async ChangeOwnPassword(_p: string, _c: string, _n: string): Promise<boolean> { return false }
    public async ResetOperatorPassword(_email: string): Promise<string>
    {
        return ''
    }

    public async SetOperatorDisabled(_email: string, _disabled: boolean, _actorPrincipalId: string): Promise<void>
    {
    }

    public async RevokeOperatorSessions(_email: string): Promise<void>
    {
    }

    public async CreateOperator(_email: string, _password: string, _role: OperatorRole): Promise<void>
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
        const sessions = await HostSessions.With(FakeOperator.Token, FakeOperator.Principal())
        const host = new ControlPlaneHost({
            Service: new StubEnvironments() as unknown as IEnvironmentService,
            Graphs: {} as unknown as IGraphService,
            PortalRoot: staticRoot,
            Operator: new FakeOperator(),
            Sessions: sessions.Sessions,
            Directory: directory,
            Deployments: await RolloutFixture.Create(parent, directory, factory),
            Provisioning: new FakeProvisioning(directory).AsService(),
            Observations: RolloutFixture.Observations(parent),
        })
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
        // Ruling (pipeline behaviour changes): refusal messages are the host's (status unchanged).
        assert.equal(JSON.parse(r.body).error, 'Forbidden host')
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
