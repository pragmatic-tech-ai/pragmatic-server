import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { ControlPlaneHost } from '../control-plane-host.js'
import type { IEnvironmentService, IGraphService } from '../control-plane-host.js'
import { ControlPlaneServer } from '../server.js'
import type { IOperatorIdentity, OperatorPrincipal, OperatorSession } from '../operator-identity.js'
import type { PlatformDirectory } from '../platform-directory.js'
import type { PlatformDeploymentRegistry } from '../platform-deployment-registry.js'
import type { TenantProvisioningService } from '../tenant-provisioning-service.js'
import type { HiveObservationRegistry } from '../hive-observation-record.js'

class NullOperator implements IOperatorIdentity
{
    public async Authenticate(_email: string, _password: string): Promise<OperatorSession | null>
    {
        return null
    }

    public async ValidateToken(_token: string): Promise<OperatorPrincipal | null>
    {
        return null
    }

    public async Revoke(_token: string): Promise<void>
    {
    }
}

class Fixture
{
    public static readonly Loopback = '127.0.0.1'
    public static readonly Attacker = 'evil.example.com'
    public static readonly Configured = 'Console.Corp.Example'
    public static readonly Forbidden = 403
    public static readonly Unauthorized = 401
    public static readonly HostHeader = 'host'
    public static readonly OriginHeader = 'origin'
    public static readonly HttpPrefix = 'http://'
    public static readonly LoginPath = '/api/login'
    public static readonly StatePath = '/api/environments'
    public static readonly Post = 'POST'
    public static readonly Get = 'GET'
    public static readonly JsonType = 'application/json'
    public static readonly ContentType = 'content-type'
    public static readonly EmptyJson = '{}'
    public static readonly HostListRaw = ' a.example , ,b.example,'

    public static Send(host: ControlPlaneHost, method: string, path: string, headers: Record<string, string>): Promise<number>
    {
        const addr = host.Address()
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: addr.address, port: addr.port, method, path, headers }, res =>
            {
                res.resume()
                res.on('end', () => resolve(res.statusCode ?? 0))
            })
            req.on('error', reject)
            req.end(method === Fixture.Post ? Fixture.EmptyJson : undefined)
        })
    }
}

describe('ControlPlaneHost host guards', () =>
{
    let root: string
    let host: ControlPlaneHost

    async function Start(allowedHosts?: readonly string[]): Promise<void>
    {
        host = new ControlPlaneHost({} as IEnvironmentService, {} as IGraphService, root, new NullOperator(), false,
            {} as PlatformDirectory, {} as PlatformDeploymentRegistry, {} as TenantProvisioningService, {} as HiveObservationRegistry,
            undefined, undefined, undefined, undefined, undefined, allowedHosts)
        await host.Listen(0, Fixture.Loopback)
    }

    beforeEach(() =>
    {
        root = mkdtempSync(join(tmpdir(), 'cp-guards-'))
    })

    afterEach(async () =>
    {
        await host.Close()
        rmSync(root, { recursive: true, force: true })
    })

    it('rejects an attacker Host even for a GET', async () =>
    {
        await Start()
        assert.equal(await Fixture.Send(host, Fixture.Get, Fixture.StatePath, { [Fixture.HostHeader]: Fixture.Attacker }), Fixture.Forbidden)
    })

    it('accepts a loopback Host with no config', async () =>
    {
        await Start()
        assert.equal(await Fixture.Send(host, Fixture.Get, Fixture.StatePath, {}), Fixture.Unauthorized)
    })

    it('accepts a Host provided via allowedHosts config (case-insensitive) and still rejects others', async () =>
    {
        await Start([Fixture.Configured])
        assert.equal(await Fixture.Send(host, Fixture.Get, Fixture.StatePath, { [Fixture.HostHeader]: Fixture.Configured }), Fixture.Unauthorized)
        assert.equal(await Fixture.Send(host, Fixture.Get, Fixture.StatePath, { [Fixture.HostHeader]: Fixture.Attacker }), Fixture.Forbidden)
    })

    it('still rejects a mutating request from a disallowed Origin', async () =>
    {
        await Start()
        const headers = { [Fixture.OriginHeader]: Fixture.HttpPrefix + Fixture.Attacker, [Fixture.ContentType]: Fixture.JsonType }
        assert.equal(await Fixture.Send(host, Fixture.Post, Fixture.StatePath, headers), Fixture.Forbidden)
    })

    it('parses the comma-separated allowed-host env list', () =>
    {
        assert.deepEqual(ControlPlaneServer.ParseHostList(Fixture.HostListRaw), ['a.example', 'b.example'])
        assert.deepEqual(ControlPlaneServer.ReadOperatorOptions({ PRAGMATIC_ADMIN_ALLOWED_HOSTS: 'x.example' }, '/d').allowedHosts, ['x.example'])
        assert.deepEqual(ControlPlaneServer.ParseHostList(undefined), [])
    })
})
