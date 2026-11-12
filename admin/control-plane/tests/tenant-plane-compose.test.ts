import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { ControlPlaneServer } from '../server.js'
import { TenantPlaneComposer } from '../tenant-plane-composer.js'
import { TenantAdminClientRegistry } from '../tenant-auth/tenant-admin-client-record.js'
import { DesktopRelay } from '../tenant-auth/desktop-relay.js'
import { AuditRegistry } from '../audit-record.js'
import type { IEnvironmentService, IGraphService } from '../control-plane-host.js'
import { EnvStatus, EnvType, Template, type EnvironmentRecord } from '../environment-record.js'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'
import { TenantGraphAccess } from '../tenant-api/tenant-graph-access.js'
import type { TenantPlane } from '../tenant-auth/tenant-plane.js'
import type { TenantSession } from '../tenant-auth/tenant-session.js'
import { ResRecorder } from './res-recorder.js'

describe('ControlPlaneServer.ExternalPortWarning', () =>
{
    it('warns once when the tenant listener is not on 80/443 and no external port is set', () =>
    {
        assert.match(ControlPlaneServer.ExternalPortWarning(7002, undefined) ?? '', /PRAGMATIC_TENANT_ADMIN_EXTERNAL_PORT/)
        assert.match(ControlPlaneServer.ExternalPortWarning(7002, undefined) ?? '', /without a proxy/)
    })

    it('is silent on 80 / 443 or when an external port is set', () =>
    {
        assert.equal(ControlPlaneServer.ExternalPortWarning(443, undefined), undefined)
        assert.equal(ControlPlaneServer.ExternalPortWarning(80, undefined), undefined)
        assert.equal(ControlPlaneServer.ExternalPortWarning(7002, 7002), undefined)
        assert.equal(ControlPlaneServer.ExternalPortWarning(7002, 443), undefined)
    })
})

describe('TenantPlaneComposer.TenantExternalPort', () =>
{
    it('is undefined when unset or blank (no port in the tenant origin, unchanged)', () =>
    {
        assert.equal(TenantPlaneComposer.TenantExternalPort(undefined), undefined)
        assert.equal(TenantPlaneComposer.TenantExternalPort(''), undefined)
    })

    it('returns a valid port', () =>
    {
        assert.equal(TenantPlaneComposer.TenantExternalPort('7002'), 7002)
        assert.equal(TenantPlaneComposer.TenantExternalPort('1'), 1)
        assert.equal(TenantPlaneComposer.TenantExternalPort('65535'), 65535)
    })

    for (const bad of ['abc', '0', '70000', '1.5', '-1'])
    {
        it(`throws naming the variable for ${bad}`, () =>
        {
            assert.throws(() => TenantPlaneComposer.TenantExternalPort(bad), /PRAGMATIC_TENANT_ADMIN_EXTERNAL_PORT/)
        })
    }
})

describe('TenantPlaneComposer.ParseSecretTtlHours', () =>
{
    const defaultHours = 168

    for (const raw of [undefined, '', '0', '-3', 'abc', '1.5'])
    {
        it(`falls back to the default for ${JSON.stringify(raw)}`, () =>
        {
            assert.equal(TenantPlaneComposer.ParseSecretTtlHours(raw), defaultHours)
        })
    }

    it('returns the integer for valid positive values', () =>
    {
        assert.equal(TenantPlaneComposer.ParseSecretTtlHours('24'), 24)
        assert.equal(TenantPlaneComposer.ParseSecretTtlHours('720'), 720)
    })
})

describe('TenantPlaneComposer.ParseHealthProbeMs', () =>
{
    const DefaultMs = 30000
    const DisabledRaw = '0'
    const ValidRaw = '5000'
    const ValidMs = 5000
    const MinBoundaryRaw = '1000'
    const MinBoundaryMs = 1000
    const TooLargeRaw = '99999999999'
    const BelowMinRaw = '007'

    for (const raw of [undefined, '', '-5', 'abc', '1.5', TooLargeRaw, BelowMinRaw])
    {
        it(`falls back to the default for ${JSON.stringify(raw)}`, () =>
        {
            assert.equal(TenantPlaneComposer.ParseHealthProbeMs(raw), DefaultMs)
        })
    }

    it('returns 0 (disabled) for zero', () =>
    {
        assert.equal(TenantPlaneComposer.ParseHealthProbeMs(DisabledRaw), 0)
    })

    it('returns the integer for a valid in-range value', () =>
    {
        assert.equal(TenantPlaneComposer.ParseHealthProbeMs(ValidRaw), ValidMs)
    })

    it('accepts the minimum boundary', () =>
    {
        assert.equal(TenantPlaneComposer.ParseHealthProbeMs(MinBoundaryRaw), MinBoundaryMs)
    })
})

describe('TenantPlaneComposer.ParseHealthProbeTimeoutMs', () =>
{
    const DefaultMs = 60000
    const DisabledRaw = '0'
    const ValidRaw = '5000'
    const ValidMs = 5000
    const MinBoundaryRaw = '1000'
    const MinBoundaryMs = 1000
    const TooLargeRaw = '99999999999'
    const BelowMinRaw = '007'

    for (const raw of [undefined, '', '-5', 'abc', '1.5', TooLargeRaw, BelowMinRaw])
    {
        it(`falls back to the default for ${JSON.stringify(raw)}`, () =>
        {
            assert.equal(TenantPlaneComposer.ParseHealthProbeTimeoutMs(raw), DefaultMs)
        })
    }

    it('returns 0 (disabled) for zero', () =>
    {
        assert.equal(TenantPlaneComposer.ParseHealthProbeTimeoutMs(DisabledRaw), 0)
    })

    it('returns the integer for a valid in-range value', () =>
    {
        assert.equal(TenantPlaneComposer.ParseHealthProbeTimeoutMs(ValidRaw), ValidMs)
    })

    it('accepts the minimum boundary', () =>
    {
        assert.equal(TenantPlaneComposer.ParseHealthProbeTimeoutMs(MinBoundaryRaw), MinBoundaryMs)
    })
})

describe('ControlPlaneServer.ComposeTenantPlane', () =>
{
    const BaseDomain = 'admin.example.com'
    const Port = '7100'
    // The deps below are only stored (not called) while composing, so stubs are safe. `never` is assignable to every param.
    const stub = {} as unknown as never

    const compose = (env: NodeJS.ProcessEnv): ReturnType<typeof ControlPlaneServer.ComposeTenantPlane> =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'tenant-plane-compose-'))
        try
        {
            const registry = new TenantAdminClientRegistry(join(dir, 'tenant-admin-clients.json'))
            return ControlPlaneServer.ComposeTenantPlane(env, dir, stub, stub, false, stub, stub, stub, stub, randomBytes(32), registry, 168)
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    }

    it('wires the relying-party with the durable secret path when the tenant env is set', () =>
    {
        const plane = compose({ PRAGMATIC_TENANT_ADMIN_PORT: Port, PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN: BaseDomain } as NodeJS.ProcessEnv)
        assert.ok(plane !== undefined)
        // Pins the production wiring: a dropped/reordered `durability` arg would silently revert to the legacy path and flip this false.
        assert.equal(plane.isDurable, true)
    })

    it('mounts the desktop surface on the control plane tenant plane, and not on a default BuildTenantPlane', () =>
    {
        const plane = compose({ PRAGMATIC_TENANT_ADMIN_PORT: Port, PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN: BaseDomain } as NodeJS.ProcessEnv)
        assert.ok(plane?.desktop !== undefined)
        const dir = mkdtempSync(join(tmpdir(), 'tenant-plane-compose-'))
        try
        {
            const registry = new TenantAdminClientRegistry(join(dir, 'tenant-admin-clients.json'))
            const standalone = TenantPlaneComposer.BuildTenantPlane(dir, stub, stub, false, stub, stub, stub, stub, randomBytes(32), registry, 168)
            assert.equal(standalone.desktop, undefined)
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('mounts the desktop relay only when the relay wiring is supplied', () =>
    {
        const env = { PRAGMATIC_TENANT_ADMIN_PORT: Port, PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN: BaseDomain } as NodeJS.ProcessEnv
        assert.equal(compose(env)?.relay, undefined)
        const dir = mkdtempSync(join(tmpdir(), 'tenant-plane-compose-'))
        try
        {
            const registry = new TenantAdminClientRegistry(join(dir, 'tenant-admin-clients.json'))
            const wired = ControlPlaneServer.ComposeTenantPlane(env, dir, stub, stub, false, stub, stub, stub, stub, randomBytes(32), registry, 168,
                undefined, undefined, { endpoints: stub, audit: stub })
            assert.ok(wired?.relay instanceof DesktopRelay)
            // Sign-out closes the session's relays: the desktop endpoint holds the same relay as its connections.
            assert.equal((wired?.desktop as unknown as { connections: unknown }).connections, wired?.relay)
            assert.equal(TenantPlaneComposer.DesktopAuditFile, 'tenant-desktop-audit.json')
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('hands the email-domain store to the tenant API only when one is supplied', () =>
    {
        const env = { PRAGMATIC_TENANT_ADMIN_PORT: Port, PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN: BaseDomain } as NodeJS.ProcessEnv
        const storeOf = (plane: ReturnType<typeof ControlPlaneServer.ComposeTenantPlane>): unknown => (plane?.api as unknown as { emailDomains: unknown }).emailDomains
        assert.equal(storeOf(compose(env)), undefined)
        const dir = mkdtempSync(join(tmpdir(), 'tenant-plane-compose-'))
        try
        {
            const registry = new TenantAdminClientRegistry(join(dir, 'tenant-admin-clients.json'))
            const view = { domains: [], editable: false, inHive: false, pending: [], verifications: [] }
            const store = { For: async () => view, Set: async () => view, Verify: async () => view }
            const wired = ControlPlaneServer.ComposeTenantPlane(env, dir, stub, stub, false, stub, stub, stub, stub, randomBytes(32), registry, 168,
                undefined, undefined, undefined, store)
            assert.equal(storeOf(wired), store)
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('returns undefined (fail-closed) when the tenant port env is unset', () =>
    {
        assert.equal(compose({ PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN: BaseDomain } as NodeJS.ProcessEnv), undefined)
    })

    it('returns undefined (fail-closed) when the base domain env is unset', () =>
    {
        assert.equal(compose({ PRAGMATIC_TENANT_ADMIN_PORT: Port } as NodeJS.ProcessEnv), undefined)
    })
})

/** A tenant API driven through BuildTenantPlane: one tenant owning a Development and a Runtime environment. */
class GraphPlane
{
    public static readonly DevGraphs = '/tenant-api/environments/dev1/graphs'
    public static readonly RuntimeGraphs = '/tenant-api/environments/rt1/graphs'
    public static readonly Get = 'GET'
    public static readonly Session: TenantSession = { id: 's1', tenantId: 't1', principalId: 'p1', email: 'o@acme.test', expiresAt: '2099-01-01T00:00:00Z' }

    public static Env(name: string, type: EnvType): EnvironmentRecord
    {
        return {
            name, type, template: Template.DevBlank, environmentId: 'eid-' + name, tenantId: 't1', hiveId: 'h1', hostPort: 8101,
            containerName: 'c-' + name, volumeName: 'v-' + name, bundleDir: '/b/' + name, createdAt: '2026-01-01T00:00:00Z', status: EnvStatus.Running
        }
    }

    public static readonly Graphs = { List: async () => [] } as unknown as IGraphService

    public static Build(dir: string, graphs: TenantGraphAccess | undefined): TenantPlane
    {
        const stub = {} as unknown as never
        const service = { List: () => [GraphPlane.Env('dev1', EnvType.Development), GraphPlane.Env('rt1', EnvType.Runtime)] } as unknown as IEnvironmentService
        const directory = { GetTenant: () => undefined, ListHives: () => [] } as unknown as ITenantDirectory
        const registry = new TenantAdminClientRegistry(join(dir, 'tenant-admin-clients.json'))
        return TenantPlaneComposer.BuildTenantPlane(dir, stub, directory, false, service, stub, stub, stub, randomBytes(32), registry, 168,
            undefined, undefined, false, false, undefined, undefined, undefined, graphs)
    }

    public static async Send(plane: TenantPlane, path: string): Promise<ResRecorder>
    {
        const req = Object.assign(Readable.from([]), { method: GraphPlane.Get, headers: {} })
        const res = new ResRecorder()
        await plane.api.Handle(req as unknown as IncomingMessage, res as unknown as ServerResponse, path, GraphPlane.Session)
        return res
    }
}

describe('ControlPlaneServer graph wiring', () =>
{
    it('names the tenant graph audit file in the data root', () =>
    {
        assert.equal(TenantPlaneComposer.TenantGraphAuditFile, 'tenant-graph-audit.json')
    })

    it('BuildTenantPlane with graph access routes the graph paths; without it they stay 404', async () =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'tenant-plane-compose-'))
        try
        {
            const access = new TenantGraphAccess(GraphPlane.Graphs, new AuditRegistry(join(dir, TenantPlaneComposer.TenantGraphAuditFile)))
            const wired = await GraphPlane.Send(GraphPlane.Build(dir, access), GraphPlane.DevGraphs)
            assert.equal(wired.status, 200)
            assert.deepEqual(wired.Json(), [])
            const unwired = await GraphPlane.Send(GraphPlane.Build(dir, undefined), GraphPlane.DevGraphs)
            assert.equal(unwired.status, 404)
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('a non-Development environment answers 400 through the composed stack', async () =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'tenant-plane-compose-'))
        try
        {
            const access = new TenantGraphAccess(GraphPlane.Graphs, new AuditRegistry(join(dir, TenantPlaneComposer.TenantGraphAuditFile)))
            const res = await GraphPlane.Send(GraphPlane.Build(dir, access), GraphPlane.RuntimeGraphs)
            assert.equal(res.status, 400)
            assert.deepEqual(res.Json(), { error: TenantGraphAccess.NotDevelopmentMessage })
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
