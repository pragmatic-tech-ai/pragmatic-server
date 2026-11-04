import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { ControlPlaneHost } from '../control-plane-host.js'
import type { IEnvironmentService, IGraphService } from '../control-plane-host.js'
import { DesktopDiscoveryEndpoint } from '../desktop-discovery-endpoint.js'
import type { IOperatorIdentity } from '../operator-identity.js'
import type { PlatformDeploymentRegistry } from '../platform-deployment-registry.js'
import type { PlatformDirectory } from '../platform-directory.js'
import type { TenantRecord } from '../platform-records.js'
import { ControlPlaneServer } from '../server.js'
import { TenantAccountIndex } from '../tenant-account-index.js'
import type { TenantProvisioningService } from '../tenant-provisioning-service.js'
import type { HiveObservationRegistry } from '../hive-observation-record.js'

class ComposeFixture
{
    public static readonly PortVar = 'PRAGMATIC_TENANT_ADMIN_PORT'
    public static readonly DomainVar = 'PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN'
    public static readonly UrlVar = 'PRAGMATIC_DESKTOP_TENANT_PLANE_URL'
    public static readonly Explicit = 'https://plane.example.test'
    public static readonly Loopback = '127.0.0.1'
    public static readonly Ann = 'ann@acme.test'
    public static readonly Plane = 'http://127.0.0.1:7002'

    public static Post(port: number, headers: Record<string, string>): Promise<number>
    {
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: ComposeFixture.Loopback, port, method: 'POST', path: '/api/desktop/discover', headers: { 'content-type': 'application/json', ...headers } }, res =>
            {
                res.resume()
                res.on('end', () => resolve(res.statusCode ?? 0))
            })
            req.on('error', reject)
            req.end(JSON.stringify({ email: ComposeFixture.Ann }))
        })
    }
}

describe('ControlPlaneServer.DesktopTenantPlaneUrlOf', () =>
{
    it('prefers the explicit override', () =>
    {
        assert.equal(ControlPlaneServer.DesktopTenantPlaneUrlOf({ [ComposeFixture.UrlVar]: ComposeFixture.Explicit }), ComposeFixture.Explicit)
    })

    it('falls back to the loopback tenant listener when the tenant plane is enabled', () =>
    {
        assert.equal(ControlPlaneServer.DesktopTenantPlaneUrlOf({ [ComposeFixture.PortVar]: '7002', [ComposeFixture.DomainVar]: 'plexus.test' }), ComposeFixture.Plane)
    })

    it('is undefined when the tenant plane is off', () =>
    {
        assert.equal(ControlPlaneServer.DesktopTenantPlaneUrlOf({ [ComposeFixture.PortVar]: '7002' }), undefined)
        assert.equal(ControlPlaneServer.DesktopTenantPlaneUrlOf({}), undefined)
    })
})

describe('ControlPlaneHost desktop discovery route', () =>
{
    let dir: string
    let host: ControlPlaneHost

    beforeEach(async () =>
    {
        dir = mkdtempSync(join(tmpdir(), 'discover-host-'))
        const index = new TenantAccountIndex(join(dir, 'tenant-accounts.json'))
        await index.Load()
        await index.Record('acme', 'owner', ComposeFixture.Ann)
        const tenant: TenantRecord = { id: 'acme', clientId: 'c1', displayName: 'Acme', createdAt: '2026-01-01T00:00:00.000Z' }
        const directory = { GetTenant: (id: string) => id === 'acme' ? tenant : undefined } as unknown as PlatformDirectory
        const endpoint = new DesktopDiscoveryEndpoint(index, directory, ComposeFixture.Plane, DesktopDiscoveryEndpoint.NewThrottle())
        host = new ControlPlaneHost({} as IEnvironmentService, {} as IGraphService, dir, {} as IOperatorIdentity, false,
            directory, {} as PlatformDeploymentRegistry, {} as TenantProvisioningService, {} as HiveObservationRegistry,
            undefined, false, undefined, undefined, undefined, [], undefined, undefined, undefined, undefined, undefined, undefined, undefined, endpoint)
        await host.Listen(0, ComposeFixture.Loopback)
    })

    afterEach(async () =>
    {
        await host.Close()
        rmSync(dir, { recursive: true, force: true })
    })

    it('serves discovery without an operator session', async () =>
    {
        assert.equal(await ComposeFixture.Post(host.Address().port, {}), 200)
    })

    it('refuses a browser request that carries an Origin header', async () =>
    {
        assert.equal(await ComposeFixture.Post(host.Address().port, { origin: 'http://evil.test' }), 403)
    })
})
