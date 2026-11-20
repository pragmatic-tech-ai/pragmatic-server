import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { InMemoryAuditRepository } from '@pragmatic-tech-ai/pragmatic-app-host'
import { InMemoryOidcFlowStateStore } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { MapSecretStore } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc/testing'
import { ControlPlaneServer } from '../server.js'
import { TenantPlaneComposer, type TenantPlaneParts } from '../tenant-plane-composer.js'
import { TenantAdminClientRegistry } from '../tenant-auth/tenant-admin-client-record.js'
import { DesktopRelay } from '../tenant-auth/desktop-relay.js'
import { AuditRegistry } from '../audit-record.js'
import type { IEnvironmentService, IGraphService } from '../control-plane-host.js'
import { EnvStatus, EnvType, Template, type EnvironmentRecord } from '../environment-record.js'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'
import { TenantGraphAccess } from '../tenant-api/tenant-graph-access.js'
import type { TenantPlane } from '../tenant-auth/tenant-plane.js'
import type { TenantSession } from '../tenant-auth/tenant-sessions.js'
import { TenantSessions } from '../tenant-auth/tenant-sessions.js'
import { TenantPrincipalSessions } from '../tenant-auth/tenant-principal-sessions.js'
import { TenantHostResolver } from '../tenant-auth/tenant-host-resolver.js'
import { TenantConsoleHost } from '../tenant-console-host.js'
import type { IEnvStatusReconciler, IHiveLister } from '../tenant-health-monitor.js'
import { MemoryRecordMap } from '../record-map.js'
import { ResRecorder } from './res-recorder.js'
import { TenantApiDispatch } from './tenant-test-sessions.js'

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

/** The parts of a tenant plane over in-memory stores; `never` stubs stand in for what composing only stores. */
class PlaneParts
{
    public static readonly BaseDomain = 'admin.example.com'
    public static readonly Port = '7100'
    public static readonly TenantEnv = { PRAGMATIC_TENANT_ADMIN_PORT: PlaneParts.Port, PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN: PlaneParts.BaseDomain } as NodeJS.ProcessEnv
    private static readonly Stub = {} as unknown as never

    public static Of(extra: Partial<TenantPlaneParts> = {}): Omit<TenantPlaneParts, 'Resolver'>
    {
        const S = PlaneParts.Stub
        const directory = { GetTenant: () => undefined, ListHives: () => [] } as unknown as ITenantDirectory
        return {
            Idp: S, Directory: directory, Service: { OnChanged: () => () => undefined } as unknown as IEnvironmentService, Rollout: S, Orchestrators: S, Placement: S,
            Sessions: new TenantSessions(TenantSessions.InMemory(), false),
            FlowStates: new InMemoryOidcFlowStateStore(),
            ClientSecrets: { Store: new MapSecretStore(), Registry: new TenantAdminClientRegistry(new MemoryRecordMap()), TtlMs: 1000 },
            ...extra,
        }
    }

    public static Resolver(): TenantHostResolver
    {
        return new TenantHostResolver(PlaneParts.BaseDomain, 'https', { GetTenant: () => undefined } as unknown as ITenantDirectory)
    }

    public static async Start(env: NodeJS.ProcessEnv, extra: Partial<TenantPlaneParts> = {}): Promise<Awaited<ReturnType<typeof ControlPlaneServer.TenantPlaneStartOf>>>
    {
        return await ControlPlaneServer.TenantPlaneStartOf(env, tmpdir(), PlaneParts.Of(extra), { ListHives: () => [] } as unknown as IHiveLister, { ListReconciled: async () => [] } as unknown as IEnvStatusReconciler, new InMemoryAuditRepository())
    }
}

describe('ControlPlaneServer.TenantPlaneStartOf', () =>
{
    it('composes the co-hosted tenant listener when the tenant env is set: the desktop surface on, the port and bind validated', async () =>
    {
        const start = await PlaneParts.Start(PlaneParts.TenantEnv)
        assert.ok(start !== undefined)
        assert.equal(start.port, 7100)
        assert.equal(start.bind, '127.0.0.1')
        assert.equal(start.baseDomain, PlaneParts.BaseDomain)
        assert.ok(start.host instanceof TenantConsoleHost)
    })

    it('mounts the desktop relay only when the relay wiring is supplied, and the desktop sign-out closes that relay', async () =>
    {
        const bare = TenantPlaneComposer.BuildTenantPlane({ ...PlaneParts.Of(), Resolver: PlaneParts.Resolver(), Desktop: true })
        assert.ok(bare.desktop !== undefined)
        assert.equal(bare.relay, undefined)
        const wired = TenantPlaneComposer.BuildTenantPlane({ ...PlaneParts.Of(), Resolver: PlaneParts.Resolver(), Desktop: true, Relay: { endpoints: {} as never, audit: {} as never } })
        assert.ok(wired.relay instanceof DesktopRelay)
        assert.equal((wired.desktop as unknown as { connections: unknown }).connections, wired.relay)
        assert.equal(TenantPlaneComposer.BuildTenantPlane({ ...PlaneParts.Of(), Resolver: PlaneParts.Resolver() }).desktop, undefined, 'no desktop surface unless asked')
    })

    it('hands the email-domain store to the tenant API only when one is supplied', () =>
    {
        const storeOf = (plane: TenantPlane): unknown => (plane.api as unknown as { emailDomains: unknown }).emailDomains
        assert.equal(storeOf(TenantPlaneComposer.BuildTenantPlane({ ...PlaneParts.Of(), Resolver: PlaneParts.Resolver() })), undefined)
        const view = { domains: [], editable: false, inHive: false, pending: [], verifications: [] }
        const store = { For: async () => view, Set: async () => view, Verify: async () => view }
        assert.equal(storeOf(TenantPlaneComposer.BuildTenantPlane({ ...PlaneParts.Of({ EmailDomains: store }), Resolver: PlaneParts.Resolver() })), store)
    })

    it('shares the given principal session ender (the Owner reset ends what the host serves)', () =>
    {
        const parts = PlaneParts.Of()
        const principals = new TenantPrincipalSessions(parts.Sessions.Store)
        assert.equal(TenantPlaneComposer.BuildTenantPlane({ ...parts, Principals: principals, Resolver: PlaneParts.Resolver() }).principals, principals)
    })

    it('is off (fail-closed) when the tenant port or the base domain env is unset', async () =>
    {
        assert.equal(await PlaneParts.Start({ PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN: PlaneParts.BaseDomain } as NodeJS.ProcessEnv), undefined)
        assert.equal(await PlaneParts.Start({ PRAGMATIC_TENANT_ADMIN_PORT: PlaneParts.Port } as NodeJS.ProcessEnv), undefined)
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

    public static Build(graphs: TenantGraphAccess | undefined): TenantPlane
    {
        const service = { List: () => [GraphPlane.Env('dev1', EnvType.Development), GraphPlane.Env('rt1', EnvType.Runtime)] } as unknown as IEnvironmentService
        return TenantPlaneComposer.BuildTenantPlane({ ...PlaneParts.Of({ Service: service, Graphs: graphs }), Resolver: PlaneParts.Resolver() })
    }

    public static async Send(plane: TenantPlane, path: string): Promise<ResRecorder>
    {
        const req = Object.assign(Readable.from([]), { method: GraphPlane.Get, headers: {} })
        const res = new ResRecorder()
        await TenantApiDispatch.Handle(plane.api, req as unknown as IncomingMessage, res as unknown as ServerResponse, path, GraphPlane.Session, TenantApiDispatch.OwnerlessDirectory)
        return res
    }
}

describe('ControlPlaneServer graph wiring', () =>
{
    it('names the pre-A5 tenant graph audit file', () =>
    {
        assert.equal(TenantPlaneComposer.TenantGraphAuditFile, 'tenant-graph-audit.json')
    })

    it('BuildTenantPlane with graph access routes the graph paths; without it they stay 404', async () =>
    {
        const access = new TenantGraphAccess(GraphPlane.Graphs, new AuditRegistry(new MemoryRecordMap()))
        const wired = await GraphPlane.Send(GraphPlane.Build(access), GraphPlane.DevGraphs)
        assert.equal(wired.status, 200)
        assert.deepEqual(wired.Json(), [])
        const unwired = await GraphPlane.Send(GraphPlane.Build(undefined), GraphPlane.DevGraphs)
        assert.equal(unwired.status, 404)
    })

    it('a non-Development environment answers 400 through the composed stack', async () =>
    {
        const access = new TenantGraphAccess(GraphPlane.Graphs, new AuditRegistry(new MemoryRecordMap()))
        const res = await GraphPlane.Send(GraphPlane.Build(access), GraphPlane.RuntimeGraphs)
        assert.equal(res.status, 400)
        assert.deepEqual(res.Json(), { error: TenantGraphAccess.NotDevelopmentMessage })
    })
})
