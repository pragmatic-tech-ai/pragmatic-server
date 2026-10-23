import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { WebSocket } from 'ws'
import { FakeProvisioning } from './fake-provisioning.js'
import { RolloutFixture } from './rollout-fixture.js'
import { ControlPlaneHost, type IEnvironmentService, type IGraphService } from '../control-plane-host.js'
import { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import { ClientRegistry } from '../client-registry.js'
import { TenantRegistry } from '../tenant-registry.js'
import { HiveRegistry } from '../hive-registry.js'
import { PlatformDirectory } from '../platform-directory.js'
import type { IOperatorIdentity, OperatorPrincipal, OperatorSession } from '../operator-identity.js'
import { EnvStatus, EnvType, Template, type EnvironmentRecord } from '../environment-record.js'
import type { ILogProcess } from '../../../environments/seed/docker.js'
import { TenantSessionStore } from '../tenant-auth/tenant-session.js'
import { TenantSessionCookie } from '../tenant-auth/tenant-session-cookie.js'
import { TenantAuthEndpoint } from '../tenant-auth/tenant-auth-endpoint.js'
import { TenantAuthGate } from '../tenant-auth/tenant-auth-gate.js'
import type { ITenantOidcRelyingParty } from '../tenant-auth/tenant-oidc-relying-party.js'
import type { ITenantApiEndpoint, TenantPlane } from '../tenant-auth/tenant-plane.js'
import { TenantEventBus } from '../tenant-api/tenant-events.js'

class FakeOperator implements IOperatorIdentity
{
    public static readonly Email = 'op@example.com'
    public static readonly Token = 'valid-token'

    public async Authenticate(email: string, password: string): Promise<OperatorSession | null>
    {
        return null
    }

    public async ValidateToken(token: string): Promise<OperatorPrincipal | null>
    {
        return token === FakeOperator.Token ? { email: FakeOperator.Email, principalId: 'p1' } : null
    }

    public async Revoke(): Promise<void>
    {
    }
}

/** A recording log process: forwards pushed chunks and flags when Kill ran. */
class FakeLogProcess implements ILogProcess
{
    public Killed = false
    private sink: ((chunk: string) => void) | undefined

    public Attach(onData: (chunk: string) => void): void
    {
        this.sink = onData
    }

    public Push(chunk: string): void
    {
        this.sink?.(chunk)
    }

    public OnData(cb: (chunk: string) => void): void
    {
        this.sink = cb
    }

    public OnClose(): void
    {
    }

    public Kill(): void
    {
        this.Killed = true
    }
}

/**
 * A minimal environment service exposing only what the streaming transport touches: the change subscription
 * (RULING 5), List (log-socket ownership check) and LogStream (the forwarded chunks). Everything else is unused.
 */
class FakeStreamingService
{
    public readonly LogStreamNames: string[] = []
    public LastLogProcess: FakeLogProcess | undefined
    private readonly changeCallbacks = new Set<(rec: EnvironmentRecord) => void>()
    private readonly records: EnvironmentRecord[]

    public constructor(records: EnvironmentRecord[])
    {
        this.records = records
    }

    public OnChanged(cb: (rec: EnvironmentRecord) => void): () => void
    {
        this.changeCallbacks.add(cb)
        return () => this.changeCallbacks.delete(cb)
    }

    public FireChange(rec: EnvironmentRecord): void
    {
        for (const cb of [...this.changeCallbacks])
        {
            cb(rec)
        }
    }

    public List(): readonly EnvironmentRecord[]
    {
        return this.records
    }

    public LogStream(name: string, onData: (chunk: string) => void): ILogProcess
    {
        this.LogStreamNames.push(name)
        const proc = new FakeLogProcess()
        proc.Attach(onData)
        this.LastLogProcess = proc
        return proc
    }
}

/** The data API is never reached by the ws routes; a no-op stub satisfies the plane. */
class StubTenantApi implements ITenantApiEndpoint
{
    public async Handle(): Promise<boolean>
    {
        return false
    }
}

class StubRelyingParty implements ITenantOidcRelyingParty
{
    public async Begin(): Promise<{ Url: string; State: string }>
    {
        return { Url: 'https://idp.test/auth', State: 's' }
    }

    public async Complete(): Promise<{ principalId: string; email?: string }>
    {
        return { principalId: 'p' }
    }
}

class Fixture
{
    public static readonly TenantHost = 'tenant.local'
    public static readonly TenantA = 't-a'
    public static readonly TenantB = 't-b'
    public static readonly EnvA = 'env-a'
    public static readonly EnvB = 'env-b'
    public static readonly HostHeader = 'Host'
    public static readonly CookieHeader = 'Cookie'
    public static readonly EventType = 'environment-changed'
    public static readonly OperatorCookie = 'cp_session=' + FakeOperator.Token

    public static Record(name: string, tenantId: string): EnvironmentRecord
    {
        return {
            name,
            type: EnvType.Development,
            template: Template.DevBlank,
            environmentId: name,
            tenantId,
            hostPort: 8101,
            containerName: 'ctr-' + name,
            volumeName: 'vol-' + name,
            bundleDir: '/bundle/' + name,
            createdAt: '2026-10-23T00:00:00.000Z',
            status: EnvStatus.Running,
        }
    }

    public static PtsCookie(tenantId: string, token: string): string
    {
        return TenantSessionCookie.Name + '=' + encodeURIComponent(tenantId) + '.' + token
    }

    public static Delay(ms: number): Promise<void>
    {
        return new Promise(res => setTimeout(res, ms))
    }

    public static Opened(ws: WebSocket): Promise<boolean>
    {
        return new Promise(res =>
        {
            ws.once('open', () => res(true))
            ws.once('error', () => res(false))
            ws.once('close', () => res(false))
        })
    }
}

describe('ControlPlaneHost tenant streaming', () =>
{
    let parent: string
    let host: ControlPlaneHost
    let store: TenantSessionStore
    let service: FakeStreamingService
    let bus: TenantEventBus

    beforeEach(async () =>
    {
        parent = mkdtempSync(join(tmpdir(), 'cp-stream-'))
        const directory = new PlatformDirectory(
            new ClientRegistry(join(parent, 'clients.json')),
            new TenantRegistry(join(parent, 'tenants.json')),
            new HiveRegistry(join(parent, 'hives.json')),
            { List: () => [] })
        const factory = new HiveOrchestratorFactory()
        store = new TenantSessionStore(join(parent, 'tenant-sessions.json'), 3600000)
        bus = new TenantEventBus()
        service = new FakeStreamingService([Fixture.Record(Fixture.EnvA, Fixture.TenantA), Fixture.Record(Fixture.EnvB, Fixture.TenantB)])
        const plane: TenantPlane = {
            endpoint: new TenantAuthEndpoint(new StubRelyingParty(), store, false),
            gate: new TenantAuthGate(store),
            api: new StubTenantApi(),
            allowedHosts: new Set([Fixture.TenantHost]),
            events: bus,
            staticRoot: join(parent, 'tenant-static'),
        }
        host = new ControlPlaneHost(
            service as unknown as IEnvironmentService,
            {} as unknown as IGraphService,
            join(parent, 'static'),
            new FakeOperator(),
            false,
            directory,
            factory,
            await RolloutFixture.Create(parent, directory, factory),
            new FakeProvisioning(directory).AsService(),
            plane)
        await host.Listen(0, '127.0.0.1')
    })

    afterEach(async () =>
    {
        await host.Close()
        rmSync(parent, { recursive: true, force: true })
    })

    function EventsUrl(): string
    {
        return `ws://127.0.0.1:${host.Address().port}/tenant-api/events`
    }

    function LogsUrl(env: string): string
    {
        return `ws://127.0.0.1:${host.Address().port}/tenant-api/environments/${env}/logs/stream`
    }

    it('delivers only the subscriber tenant own events (no cross-tenant leak)', async () =>
    {
        const issued = await store.Issue(Fixture.TenantA, 'u1')
        const ws = new WebSocket(EventsUrl(), { headers: { [Fixture.HostHeader]: Fixture.TenantHost, [Fixture.CookieHeader]: Fixture.PtsCookie(Fixture.TenantA, issued.id) } })
        assert.equal(await Fixture.Opened(ws), true)
        const received: Array<{ type: string; environmentName: string }> = []
        ws.on('message', d => received.push(JSON.parse(d.toString())))
        // Fire a tenant-B change first (must NOT leak) then a tenant-A change (must arrive).
        service.FireChange(Fixture.Record(Fixture.EnvB, Fixture.TenantB))
        service.FireChange(Fixture.Record(Fixture.EnvA, Fixture.TenantA))
        for (let i = 0; i < 50 && received.length === 0; i++)
        {
            await Fixture.Delay(10)
        }
        await Fixture.Delay(50)
        assert.equal(received.length, 1)
        assert.deepEqual(received[0], { type: Fixture.EventType, environmentName: Fixture.EnvA })
        ws.close()
    })

    it('rejects an events socket with no pts_session cookie', async () =>
    {
        const ws = new WebSocket(EventsUrl(), { headers: { [Fixture.HostHeader]: Fixture.TenantHost } })
        assert.equal(await Fixture.Opened(ws), false)
    })

    it('rejects an events socket carrying only an operator cookie', async () =>
    {
        const ws = new WebSocket(EventsUrl(), { headers: { [Fixture.HostHeader]: Fixture.TenantHost, [Fixture.CookieHeader]: Fixture.OperatorCookie } })
        assert.equal(await Fixture.Opened(ws), false)
    })

    it('streams log chunks for an owned env and kills the process on close', async () =>
    {
        const issued = await store.Issue(Fixture.TenantA, 'u1')
        const ws = new WebSocket(LogsUrl(Fixture.EnvA), { headers: { [Fixture.HostHeader]: Fixture.TenantHost, [Fixture.CookieHeader]: Fixture.PtsCookie(Fixture.TenantA, issued.id) } })
        assert.equal(await Fixture.Opened(ws), true)
        // The upgrade callback runs just after 'open'; give Attach a tick to start the stream.
        for (let i = 0; i < 50 && service.LastLogProcess === undefined; i++)
        {
            await Fixture.Delay(10)
        }
        const chunk = new Promise<string>(res => ws.once('message', d => res(d.toString())))
        service.LastLogProcess!.Push('log-chunk-1')
        assert.equal(await chunk, 'log-chunk-1')
        assert.deepEqual(service.LogStreamNames, [Fixture.EnvA])
        const closed = new Promise<void>(res => ws.once('close', () => res()))
        ws.close()
        await closed
        for (let i = 0; i < 50 && !service.LastLogProcess!.Killed; i++)
        {
            await Fixture.Delay(10)
        }
        assert.equal(service.LastLogProcess!.Killed, true)
    })

    it('rejects a logs socket for an env owned by another tenant and starts no stream', async () =>
    {
        const issued = await store.Issue(Fixture.TenantA, 'u1')
        const ws = new WebSocket(LogsUrl(Fixture.EnvB), { headers: { [Fixture.HostHeader]: Fixture.TenantHost, [Fixture.CookieHeader]: Fixture.PtsCookie(Fixture.TenantA, issued.id) } })
        // The upgrade may briefly complete before the ownership check closes it; wait for the close either way.
        await new Promise<void>(res =>
        {
            let settled = false
            const done = (): void => { if (!settled) { settled = true; res() } }
            ws.once('close', done)
            ws.once('error', done)
            ws.once('open', () => setTimeout(done, 200))
        })
        assert.equal(service.LogStreamNames.includes(Fixture.EnvB), false)
    })

    it('rejects a logs socket with no pts_session cookie', async () =>
    {
        const ws = new WebSocket(LogsUrl(Fixture.EnvA), { headers: { [Fixture.HostHeader]: Fixture.TenantHost } })
        assert.equal(await Fixture.Opened(ws), false)
        assert.equal(service.LogStreamNames.includes(Fixture.EnvA), false)
    })
})
