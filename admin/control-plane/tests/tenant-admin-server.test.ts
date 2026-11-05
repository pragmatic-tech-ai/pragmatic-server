import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InjectedIdpService } from '../injected-idp-service.js'
import { IdpService } from '../idp-service.js'
import { TenantAdminServer, type TenantAdminComposition } from '../tenant-admin-server.js'
import { SeededTenantDirectory } from '../tenant-api/seeded-tenant-directory.js'
import { TenantApiEndpoint } from '../tenant-api/tenant-api-endpoint.js'
import { RolloutUnavailableError, type IRolloutClient } from '../tenant-api/rollout-client.js'
import { UnconfiguredRolloutClient } from '../tenant-api/unconfigured-rollout-client.js'
import { HttpRolloutClient } from '../tenant-api/http-rollout-client.js'
import { InClusterEnvironmentReach } from '../in-cluster-environment-reach.js'
import { InClusterServiceAccount } from '../kube-api-client.js'
import { PinnedImageVerifier } from '../pinned-image-verifier.js'
import { EnvironmentPlacement } from '../environment-placement.js'
import { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import type { HiveRecord, TenantRecord } from '../platform-records.js'
import { TenantSessionKind, type TenantSession } from '../tenant-auth/tenant-session.js'
import { ControlPlaneServer } from '../server.js'
import { TenantAdminEnv } from '../tenant-admin-env.js'
import { ConsoleAdvertSender } from '../console-advert-sender.js'
import { ConsoleEmailDomainStore } from '../console-email-domain-store.js'
import { ConsoleOwnerResetFollower } from '../console-owner-reset-follower.js'
import { WebSocket } from 'ws'
import { KubeHttpsTransport } from '../../../src/agent/kube-https-transport.js'
import type { AuditRegistry } from '../audit-record.js'
import { NodeExecFile, NodeProcessSpawner } from '../kubectl.js'
import { DesktopRelay } from '../tenant-auth/desktop-relay.js'

class FakeRolloutClient implements IRolloutClient
{
    public async ManifestsFor(): Promise<never[]>
    {
        return []
    }

    public async StatusFor(): Promise<never>
    {
        throw new Error(Names.Unused)
    }

    public AdoptTarget(): Promise<void>
    {
        return Promise.resolve()
    }

    public async LedgerFor(): Promise<never[]>
    {
        return []
    }
}

class Names
{
    public static readonly DataRootVar = 'PRAGMATIC_TENANT_ADMIN_DATA_ROOT'
    public static readonly PortVar = 'PRAGMATIC_TENANT_ADMIN_PORT'
    public static readonly DomainVar = 'PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN'
    public static readonly SeedFile = 'seed.json'
    public static readonly MasterKeyFile = 'master.key'
    public static readonly TenantId = 'acme'
    public static readonly TenantName = 'Acme'
    public static readonly OtherTenantId = 'other'
    public static readonly HiveId = 'h1'
    public static readonly SecondHiveId = 'h2'
    public static readonly Created = '2026-01-01T00:00:00Z'
    public static readonly Expires = '2099-01-01T00:00:00Z'
    public static readonly Domain = 'admin.example.com'
    public static readonly Port = '7100'
    public static readonly DefaultBind = '127.0.0.1'
    public static readonly DefaultScheme = 'https'
    public static readonly TempPrefix = 'tenant-admin-server-'
    public static readonly FreshDir = 'fresh'
    public static readonly Unused = 'unused'
    public static readonly HivePattern = /hive/
    public static readonly NoRolloutPattern = /No rollout client/
    public static readonly ManifestsPath = '/tenant-api/manifests'
    public static readonly RolloutPathSuffix = '/rollout'
    public static readonly HivesPathPrefix = '/tenant-api/hives/'
    public static readonly Get = 'GET'
    public static readonly KeyBytes = 32
    public static readonly Unavailable = 503
    public static readonly OwnerEmail = 'owner@acme.test'
    public static readonly PrincipalId = 'p'
    public static readonly EmailDomain = 'acme.test'
    public static readonly NewEmailDomain = 'acme-corp.test'
    public static readonly ConsoleHost = 'console-acme.localtest.me'
    public static readonly ConsoleUrl = 'https://console-acme.localtest.me'
    public static readonly FingerprintKeyName = 'fingerprint.key'
    public static readonly MountedKeyFile = '/fingerprint/fingerprint.key'
    public static readonly RolloutUrl = 'http://channel.example:7000'
    public static readonly RolloutToken = 'tok-secret'
    public static readonly ProbeVar = 'PRAGMATIC_TENANT_ADMIN_HEALTH_PROBE_MS'
    public static readonly AdvertPath = '/agent/hives/h1/console'
    public static readonly EmailDomainsPath = '/tenant-api/settings/email-domains'
    public static readonly SettleMs = 100
    public static readonly ClientId = 'c1'
    public static readonly HiveName = 'Hive'
    public static readonly ClusterKind = 'kind'
    public static readonly RegistryKind = 'local'
    public static readonly SessionId = 's'
    public static readonly ProbeOff = '0'
    public static readonly Put = 'PUT'
    public static readonly Ok = 200
    public static readonly ContentTypeHeader = 'Content-Type'
    public static readonly JsonType = 'application/json'
    public static readonly OkBody = '{"refusedEmailDomains":[]}'
    public static readonly OtherPrincipalId = 'someone-else'
    /** A pause so a revocation's stamp is strictly later than the sessions issued before it. */
    public static readonly TickMs = 5
    public static readonly OwnerResetAt = '2026-11-04T10:00:00.000Z'
    public static readonly SendFailed = 'send failed'
    public static readonly Utf8 = 'utf8'
    public static readonly CloseEvent = 'close'
    public static readonly ConsolePath = '/desktop/console'
    public static readonly DesktopAuditFile = 'tenant-desktop-audit.json'
    public static readonly ServiceHostVar = 'KUBERNETES_SERVICE_HOST'
    public static readonly ServiceHost = '10.0.0.1'
    public static readonly ServiceAccountDir = 'sa'
    public static readonly TokenFile = 'token'
    public static readonly CaFile = 'ca.crt'
    public static readonly ClientAddress = '127.0.0.1'
    public static readonly AuditActor = 'acme/ann@acme.test'
    public static readonly AuditMethod = 'contribute'
    public static readonly AuditPath = 'acme-dev'
    public static readonly EmptyJson = 'null'
    public static readonly Unauthorized = 401
}

/**
 * Fails every outward call a composition could make (Kubernetes API over HTTPS, kubectl via execFile or spawn) and
 * records it, so a test can assert none happened. Install patches the prototypes; Restore puts them back.
 */
class NetworkTrap
{
    private static readonly NotExpected = 'no outward call is expected here'
    private static readonly Separator = ' '
    public readonly Calls: string[] = []
    private readonly send = KubeHttpsTransport.prototype.Send
    private readonly run = NodeExecFile.prototype.Run
    private readonly spawn = NodeProcessSpawner.prototype.Spawn

    public Install(): void
    {
        KubeHttpsTransport.prototype.Send = (method: string, path: string) => this.Refuse(method + NetworkTrap.Separator + path)
        NodeExecFile.prototype.Run = (file: string, args: readonly string[]) => this.Refuse(file + NetworkTrap.Separator + args.join(NetworkTrap.Separator))
        NodeProcessSpawner.prototype.Spawn = (file: string, args: readonly string[]) =>
        {
            this.Calls.push(file + NetworkTrap.Separator + args.join(NetworkTrap.Separator))
            throw new Error(NetworkTrap.NotExpected)
        }
    }

    public Restore(): void
    {
        KubeHttpsTransport.prototype.Send = this.send
        NodeExecFile.prototype.Run = this.run
        NodeProcessSpawner.prototype.Spawn = this.spawn
    }

    private Refuse(call: string): Promise<never>
    {
        this.Calls.push(call)
        return Promise.reject(new Error(NetworkTrap.NotExpected))
    }
}

/** Holds one AuditRegistry's file writes inside WriteText until Release (as tests/held-audit.ts, on an existing instance). */
class HeldWrite
{
    public Written = false
    public readonly Entered: Promise<void>
    private enter: () => void = () => undefined
    private release: () => void = () => undefined

    public constructor(audit: AuditRegistry)
    {
        this.Entered = new Promise<void>(res => { this.enter = res })
        const gate = new Promise<void>(res => { this.release = res })
        const target = audit as unknown as { WriteText(text: string): Promise<void> }
        const write = target.WriteText.bind(audit)
        target.WriteText = async (text: string) =>
        {
            this.enter()
            await gate
            await write(text)
            this.Written = true
        }
    }

    public Release(): void
    {
        this.release()
    }
}

/** Probes a composed, listening host. */
class HostProbe
{
    private static readonly RelayQuery = '?environment=acme-dev&action=contribute'
    private static readonly UnexpectedResponse = 'unexpected-response'
    private static readonly OpenEvent = 'open'
    private static readonly ErrorEvent = 'error'

    /** True once the host's listener is gone (Address throws when nothing listens). */
    public static IsClosed(composition: TenantAdminComposition): boolean
    {
        try
        {
            composition.host.Address()
            return false
        }
        catch
        {
            return true
        }
    }

    /** Dials `/desktop/relay` with no bearer; resolves the HTTP status of the refusal (-1 when it opened or failed). */
    public static UnauthenticatedRelay(composition: TenantAdminComposition): Promise<number>
    {
        const port = composition.host.Address().port
        const ws = new WebSocket('ws://' + Names.DefaultBind + ':' + String(port) + DesktopRelay.Path + HostProbe.RelayQuery)
        return new Promise(res =>
        {
            ws.once(HostProbe.UnexpectedResponse, (_req, response) =>
            {
                res(response.statusCode ?? 0)
                ws.terminate()
            })
            ws.once(HostProbe.OpenEvent, () =>
            {
                res(-1)
                ws.terminate()
            })
            ws.once(HostProbe.ErrorEvent, () => res(-1))
        })
    }
}

/** Drives `/desktop/*` requests straight through a composed plane's desktop endpoint, as Plexus would (no Origin header). */
class DesktopProbe
{
    public static async Get(composition: TenantAdminComposition, path: string): Promise<{ handled: boolean; status: number; body: unknown }>
    {
        const req = Object.assign(Readable.from([]), { method: Names.Get, headers: {}, socket: { remoteAddress: Names.ClientAddress } })
        let status = 0
        let text = Names.EmptyJson
        const res = { writeHead: (s: number) => { status = s }, end: (b: string) => { text = b } }
        const desktop = composition.plane.desktop
        assert.ok(desktop !== undefined, 'the console plane carries the desktop surface')
        const handled = await desktop.Handle(req as unknown as IncomingMessage, res as unknown as ServerResponse, path)
        return { handled, status, body: JSON.parse(text) }
    }
}

describe('TenantAdminServer', () =>
{
    const tenant: TenantRecord = { id: Names.TenantId, clientId: Names.ClientId, displayName: Names.TenantName, createdAt: Names.Created }
    const hive: HiveRecord = {
        id: Names.HiveId, tenantId: Names.TenantId, displayName: Names.HiveName, createdAt: Names.Created,
        cluster: { kind: Names.ClusterKind } as unknown as HiveRecord['cluster'],
        registry: { kind: Names.RegistryKind } as unknown as HiveRecord['registry'],
    }
    let root = ''

    const env = (): NodeJS.ProcessEnv => ({ [Names.DataRootVar]: root, [Names.PortVar]: Names.Port, [Names.DomainVar]: Names.Domain })
    const writeSeedJson = (body: unknown): void => writeFileSync(join(root, Names.SeedFile), JSON.stringify(body))
    const writeSeed = (): void => writeSeedJson({ tenant, hives: [hive] })

    beforeEach(() =>
    {
        root = mkdtempSync(join(tmpdir(), Names.TempPrefix))
    })

    afterEach(() =>
    {
        rmSync(root, { recursive: true, force: true })
    })

    it('ReadConfig parses env and applies defaults', () =>
    {
        const cfg = TenantAdminServer.ReadConfig(env())
        assert.equal(cfg.dataRoot, root)
        assert.equal(cfg.port, Number(Names.Port))
        assert.equal(cfg.baseDomain, Names.Domain)
        assert.equal(cfg.bind, Names.DefaultBind)
        assert.equal(cfg.scheme, Names.DefaultScheme)
        assert.equal(cfg.secureCookie, false)
        assert.equal(cfg.externalPort, undefined)
        assert.equal(cfg.trustedProxy, false, 'the tenant listener trusts no proxy unless told to')
    })

    it('ReadConfig reads PRAGMATIC_TENANT_ADMIN_TRUSTED_PROXY (its own flag, not the operator listener\'s)', () =>
    {
        assert.equal(TenantAdminServer.ReadConfig({ ...env(), PRAGMATIC_TENANT_ADMIN_TRUSTED_PROXY: 'true' }).trustedProxy, true)
        assert.equal(TenantAdminServer.ReadConfig({ ...env(), PRAGMATIC_ADMIN_TRUSTED_PROXY: 'true' }).trustedProxy, false)
    })

    it('ReadConfig reads an optional external port, validated like the other ports', () =>
    {
        const e = env()
        e['PRAGMATIC_TENANT_ADMIN_EXTERNAL_PORT'] = '7002'
        assert.equal(TenantAdminServer.ReadConfig(e).externalPort, 7002)
        e['PRAGMATIC_TENANT_ADMIN_EXTERNAL_PORT'] = ''
        assert.equal(TenantAdminServer.ReadConfig(e).externalPort, undefined)
        for (const bad of ['abc', '0', '70000', '1.5'])
        {
            e['PRAGMATIC_TENANT_ADMIN_EXTERNAL_PORT'] = bad
            assert.throws(() => TenantAdminServer.ReadConfig(e), /PRAGMATIC_TENANT_ADMIN_EXTERNAL_PORT/)
        }
    })

    it('ReadConfig reads the console host and TLS settings', () =>
    {
        const none = TenantAdminServer.ReadConfig(env())
        assert.equal(none.consoleHost, undefined)
        assert.equal(none.ingressTls, undefined)
        const cfg = TenantAdminServer.ReadConfig({
            ...env(),
            PRAGMATIC_TENANT_ADMIN_CONSOLE_HOST: 'console-acme.localtest.me',
            PRAGMATIC_TENANT_ADMIN_INGRESS_TLS_SOURCE: 'development',
        })
        assert.equal(cfg.consoleHost, 'console-acme.localtest.me')
        assert.equal(cfg.ingressTls?.source, 'development')
    })

    it('InClusterOrchestrationOf takes the identity from the seed', () =>
    {
        writeSeed()
        const directory = TenantAdminServer.LoadSeed(root)
        const account = new InClusterServiceAccount('/t', '/c')
        const setup = TenantAdminServer.InClusterOrchestrationOf(account, directory, root)
        assert.deepEqual(setup.identity, { tenantId: Names.TenantId, hiveId: Names.HiveId })
        assert.ok(setup.verifier instanceof PinnedImageVerifier)
    })

    it('Compose without a service account keeps kubectl orchestration and no reach', async () =>
    {
        writeSeed()
        writeFileSync(join(root, Names.MasterKeyFile), randomBytes(Names.KeyBytes))
        const server = new TenantAdminServer(TenantAdminServer.ReadConfig(env()), new FakeRolloutClient())
        const composition = await server.Compose({})
        assert.equal(composition.reach, undefined)
    })

    it('Compose in a pod builds the reach', async () =>
    {
        writeSeedJson({ tenant, hives: [{ ...hive, cluster: { backend: 'local', mode: 'attach' } }] })
        writeFileSync(join(root, Names.MasterKeyFile), randomBytes(Names.KeyBytes))
        const saRoot = join(root, 'sa')
        mkdirSync(saRoot)
        writeFileSync(join(saRoot, 'token'), 't')
        writeFileSync(join(saRoot, 'ca.crt'), 'c')
        const server = new TenantAdminServer(TenantAdminServer.ReadConfig(env()), new FakeRolloutClient())
        const composition = await server.Compose({ ...env(), KUBERNETES_SERVICE_HOST: '10.0.0.1' }, saRoot)
        assert.ok(composition.reach instanceof InClusterEnvironmentReach)
    })

    /** A pod's seed (an attachable local cluster) and a temp service-account dir; returns the dir. */
    const writePod = (): string =>
    {
        writeSeedJson({ tenant, hives: [{ ...hive, cluster: { backend: 'local', mode: 'attach' } }] })
        writeFileSync(join(root, Names.MasterKeyFile), randomBytes(Names.KeyBytes))
        const saRoot = join(root, Names.ServiceAccountDir)
        mkdirSync(saRoot)
        writeFileSync(join(saRoot, Names.TokenFile), Names.TokenFile)
        writeFileSync(join(saRoot, Names.CaFile), Names.CaFile)
        return saRoot
    }

    it('Compose without a service account has no relay', async () =>
    {
        writeSeed()
        writeFileSync(join(root, Names.MasterKeyFile), randomBytes(Names.KeyBytes))
        const server = new TenantAdminServer(TenantAdminServer.ReadConfig(env()), new FakeRolloutClient())
        const composition = await server.Compose({}, undefined, () => undefined)
        assert.ok(composition.plane.desktop !== undefined, 'sign-in and targets are still served')
        assert.equal(composition.plane.relay, undefined)
    })

    it('Compose in a pod mounts the relay over the composition\'s reach and audits under the data root', async () =>
    {
        const saRoot = writePod()
        const server = new TenantAdminServer(TenantAdminServer.ReadConfig(env()), new FakeRolloutClient())
        const trap = new NetworkTrap()
        trap.Install()
        let composition: TenantAdminComposition
        try
        {
            composition = await server.Compose({ ...env(), [Names.ServiceHostVar]: Names.ServiceHost }, saRoot, () => undefined)
            await new Promise<void>(res => setTimeout(res, Names.SettleMs))
        }
        finally
        {
            trap.Restore()
        }
        assert.deepEqual(trap.Calls, [], 'no Kubernetes API call and no kubectl process at compose')
        assert.ok(composition.reach instanceof InClusterEnvironmentReach)
        assert.ok(composition.plane.relay !== undefined)
        assert.equal(existsSync(join(root, Names.DesktopAuditFile)), false, 'nothing is written at compose')
        await composition.desktopAudit.Append({ actor: Names.AuditActor, method: Names.AuditMethod, path: Names.AuditPath, status: Names.Ok, at: Names.Created })
        assert.ok(existsSync(join(root, Names.DesktopAuditFile)))
    })

    it('closing the composed host closes the listener, then the relay, and waits for its audit writes', async () =>
    {
        const saRoot = writePod()
        const cfg = TenantAdminServer.ReadConfig({ ...env(), [Names.ProbeVar]: Names.ProbeOff })
        const composition = await new TenantAdminServer(cfg, new FakeRolloutClient()).Compose({ ...env(), [Names.ServiceHostVar]: Names.ServiceHost }, saRoot, () => undefined)
        const relay = composition.plane.relay
        assert.ok(relay !== undefined)
        const held = new HeldWrite(composition.desktopAudit)
        const close = relay.Close.bind(relay)
        let listenerClosedFirst: boolean | undefined
        relay.Close = async () =>
        {
            listenerClosedFirst = HostProbe.IsClosed(composition)
            await close()
        }
        await composition.host.Listen(0, Names.DefaultBind)
        try
        {
            // An unauthenticated relay upgrade is refused and audited; its file write is held.
            assert.equal(await HostProbe.UnauthenticatedRelay(composition), Names.Unauthorized)
            await held.Entered
            let closed = false
            const closing = composition.host.Close().then(() => { closed = true })
            await new Promise<void>(res => setTimeout(res, Names.SettleMs))
            assert.equal(closed, false, 'Close waits for the held audit write')
            assert.equal(listenerClosedFirst, true, 'the relay closes only after the listener has closed')
            held.Release()
            await closing
            assert.equal(held.Written, true, 'the audit write finished before Close resolved')
        }
        finally
        {
            held.Release()
            await composition.host.Close()
        }
    })

    it('Compose loads the desktop audit file before building the plane', async () =>
    {
        const saRoot = writePod()
        const podEnv = { ...env(), [Names.ServiceHostVar]: Names.ServiceHost }
        const first = await new TenantAdminServer(TenantAdminServer.ReadConfig(env()), new FakeRolloutClient()).Compose(podEnv, saRoot, () => undefined)
        await first.desktopAudit.Append({ actor: Names.AuditActor, method: Names.AuditMethod, path: Names.AuditPath, status: Names.Ok, at: Names.Created })
        const second = await new TenantAdminServer(TenantAdminServer.ReadConfig(env()), new FakeRolloutClient()).Compose(podEnv, saRoot, () => undefined)
        assert.deepEqual(second.desktopAudit.List().map(r => r.actor), [Names.AuditActor])
    })

    for (const missing of [Names.DataRootVar, Names.PortVar, Names.DomainVar])
    {
        it(`ReadConfig throws a clear error when ${missing} is missing`, () =>
        {
            const e = env()
            delete e[missing]
            assert.throws(() => TenantAdminServer.ReadConfig(e), new RegExp(missing))
        })
    }

    for (const badPort of ['abc', '0', '70000', '1.5'])
    {
        it(`ReadConfig throws a clear error for invalid port ${badPort}`, () =>
        {
            const e = env()
            e[Names.PortVar] = badPort
            assert.throws(() => TenantAdminServer.ReadConfig(e), new RegExp(Names.PortVar))
        })
    }

    it('LoadSeed builds a SeededTenantDirectory resolving the seeded tenant and hive', () =>
    {
        writeSeed()
        const dir = TenantAdminServer.LoadSeed(root)
        assert.ok(dir instanceof SeededTenantDirectory)
        assert.equal(dir.GetTenant(Names.TenantId)?.displayName, Names.TenantName)
        assert.equal(dir.GetTenant(Names.OtherTenantId), undefined)
        assert.equal(dir.ListHives(Names.TenantId).length, 1)
    })

    it('SeededTenantDirectory.ListHives() with no argument returns every seeded hive', () =>
    {
        const dir = new SeededTenantDirectory({ tenant, hives: [hive, { ...hive, id: Names.SecondHiveId }] })
        assert.deepEqual(dir.ListHives().map(h => h.id), [Names.HiveId, Names.SecondHiveId])
        assert.equal(dir.ListHives(Names.OtherTenantId).length, 0)
    })

    it('LoadSeed throws a clear error when seed.json is missing or malformed', () =>
    {
        assert.throws(() => TenantAdminServer.LoadSeed(root), new RegExp(Names.SeedFile))
        writeSeedJson({ hives: [] })
        assert.throws(() => TenantAdminServer.LoadSeed(root), new RegExp(Names.SeedFile))
    })

    it('LoadSeed rejects malformed hive elements', () =>
    {
        writeSeedJson({ tenant, hives: [{ id: Names.HiveId }] })
        assert.throws(() => TenantAdminServer.LoadSeed(root), Names.HivePattern)
        writeSeedJson({ tenant, hives: [null] })
        assert.throws(() => TenantAdminServer.LoadSeed(root), Names.HivePattern)
    })

    it('Compose fails on a missing seed or master key and leaves no data dir behind', async () =>
    {
        const fresh = join(root, Names.FreshDir)
        const e = env()
        e[Names.DataRootVar] = fresh
        const server = new TenantAdminServer(TenantAdminServer.ReadConfig(e), new FakeRolloutClient())
        await assert.rejects(() => server.Compose(), new RegExp(Names.SeedFile))
        assert.equal(existsSync(fresh), false)
        writeSeed()
        const second = new TenantAdminServer(TenantAdminServer.ReadConfig(env()), new FakeRolloutClient())
        await assert.rejects(() => second.Compose(), new RegExp(Names.MasterKeyFile))
    })

    it('Compose wires the seeded directory and injected rollout client under its own data root', async () =>
    {
        writeSeed()
        writeFileSync(join(root, Names.MasterKeyFile), randomBytes(Names.KeyBytes))
        const rollout = new FakeRolloutClient()
        const server = new TenantAdminServer(TenantAdminServer.ReadConfig(env()), rollout)
        const composition = await server.Compose()
        assert.equal(composition.rollout, rollout)
        assert.ok(composition.directory instanceof SeededTenantDirectory)
        assert.equal(composition.directory.GetTenant(Names.TenantId)?.id, Names.TenantId)
        assert.ok(composition.plane.endpoint)
        assert.ok(composition.plane.api)
        assert.ok(composition.plane.isDurable)
        assert.ok(composition.host)
        assert.ok(composition.monitor)
    })
})

class Waits
{
    private static readonly PollMs = 10
    private static readonly TimeoutMs = 5000
    private static readonly TimeoutMessage = 'the condition did not hold in time'

    public static async Until(condition: () => boolean): Promise<void>
    {
        const deadline = Date.now() + Waits.TimeoutMs
        while (!condition())
        {
            if (Date.now() > deadline)
            {
                throw new Error(Waits.TimeoutMessage)
            }
            await new Promise<void>(res => setTimeout(res, Waits.PollMs))
        }
    }
}

describe('TenantAdminServer console advert', () =>
{
    const tenant: TenantRecord = {
        id: Names.TenantId, clientId: Names.ClientId, displayName: Names.TenantName, createdAt: Names.Created,
        ownerEmail: Names.OwnerEmail, ownerPrincipalId: Names.PrincipalId, emailDomains: [Names.EmailDomain],
    }
    const hive: HiveRecord = {
        id: Names.HiveId, tenantId: Names.TenantId, displayName: Names.HiveName, createdAt: Names.Created,
        cluster: { kind: Names.ClusterKind } as unknown as HiveRecord['cluster'],
        registry: { kind: Names.RegistryKind } as unknown as HiveRecord['registry'],
    }
    const session: TenantSession = { id: Names.SessionId, tenantId: Names.TenantId, principalId: Names.PrincipalId, expiresAt: Names.Expires }
    const writeConsoleSeed = (): void =>
    {
        writeFileSync(join(root, Names.SeedFile), JSON.stringify({ tenant, hives: [hive] }))
        writeFileSync(join(root, Names.MasterKeyFile), randomBytes(Names.KeyBytes))
    }
    const runEnv = async (url: string): Promise<NodeJS.ProcessEnv> => ({ ...advertEnv(url), [Names.PortVar]: String(await freePort()), [Names.ProbeVar]: Names.ProbeOff })
    let root = ''
    let keyFile = ''
    let channel: Server | undefined
    let posts: Array<{ url: string | undefined; body: unknown }> = []
    /** Hanging requests whose connection the client dropped. */
    let abandoned = 0
    /** What the local agent channel answers a 200 advert with. */
    let answerBody = Names.OkBody

    const baseEnv = (): NodeJS.ProcessEnv => ({ [Names.DataRootVar]: root, [Names.PortVar]: Names.Port, [Names.DomainVar]: Names.Domain })
    const advertEnv = (rolloutUrl: string = Names.RolloutUrl): NodeJS.ProcessEnv => ({
        ...baseEnv(),
        [TenantAdminEnv.ConsoleHost]: Names.ConsoleHost,
        [TenantAdminEnv.FingerprintKeyFile]: keyFile,
        [TenantAdminEnv.RolloutUrl]: rolloutUrl,
        [TenantAdminEnv.RolloutToken]: Names.RolloutToken,
        [TenantAdminEnv.RolloutHiveId]: Names.HiveId,
    })
    const store = (): Promise<ConsoleEmailDomainStore> => ConsoleEmailDomainStore.Open(join(root, ConsoleEmailDomainStore.FileName), Names.TenantId, tenant.emailDomains)

    beforeEach(() =>
    {
        root = mkdtempSync(join(tmpdir(), Names.TempPrefix))
        keyFile = join(root, Names.FingerprintKeyName)
        writeFileSync(keyFile, randomBytes(Names.KeyBytes))
        posts = []
        abandoned = 0
        answerBody = Names.OkBody
    })

    afterEach(async () =>
    {
        const s = channel
        channel = undefined
        if (s !== undefined)
        {
            s.closeAllConnections()
            await new Promise<void>(res => s.close(() => res()))
        }
        rmSync(root, { recursive: true, force: true })
    })

    /** A local agent channel recording every advert; it answers the first `answered` posts and leaves later ones hanging. */
    const listenChannel = async (answered: number = Number.POSITIVE_INFINITY): Promise<string> =>
    {
        channel = createServer((req, res) =>
        {
            const chunks: Buffer[] = []
            req.on('data', (c: Buffer) => chunks.push(c))
            req.on('end', () =>
            {
                posts.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) })
                if (posts.length > answered)
                {
                    res.on(Names.CloseEvent, () => { abandoned++ })
                    return
                }
                res.writeHead(Names.Ok, { [Names.ContentTypeHeader]: Names.JsonType })
                res.end(answerBody)
            })
        })
        await new Promise<void>(res => channel!.listen(0, Names.DefaultBind, () => res()))
        return `http://${Names.DefaultBind}:${(channel!.address() as AddressInfo).port}`
    }

    const freePort = async (): Promise<number> =>
    {
        const probe = createServer()
        await new Promise<void>(res => probe.listen(0, Names.DefaultBind, () => res()))
        const port = (probe.address() as AddressInfo).port
        await new Promise<void>(res => probe.close(() => res()))
        return port
    }

    it('ReadConfig reads the fingerprint key file', () =>
    {
        assert.equal(TenantAdminServer.ReadConfig(baseEnv()).fingerprintKeyFile, undefined)
        assert.equal(TenantAdminServer.ReadConfig({ ...baseEnv(), [TenantAdminEnv.FingerprintKeyFile]: Names.MountedKeyFile }).fingerprintKeyFile, Names.MountedKeyFile)
    })

    it('AdvertSenderOf builds the sender when every setting is present', async () =>
    {
        const lines: string[] = []
        const env = advertEnv()
        const sender = TenantAdminServer.AdvertSenderOf(env, TenantAdminServer.ReadConfig(env), tenant, await store(), line => lines.push(line))
        assert.ok(sender instanceof ConsoleAdvertSender)
        assert.equal(sender.Body().consoleUrl, Names.ConsoleUrl)
        assert.equal(sender.Body().fingerprints.length, 1)
        assert.deepEqual(lines, [])
    })

    for (const missing of [TenantAdminEnv.ConsoleHost, TenantAdminEnv.FingerprintKeyFile, TenantAdminEnv.RolloutUrl, TenantAdminEnv.RolloutToken, TenantAdminEnv.RolloutHiveId])
    {
        it(`AdvertSenderOf needs the console host, the fingerprint key and the agent channel (${missing})`, async () =>
        {
            const lines: string[] = []
            const env = advertEnv()
            const values = [Names.ConsoleHost, keyFile, Names.RolloutUrl, Names.RolloutToken, Names.HiveId]
            delete env[missing]
            assert.equal(TenantAdminServer.AdvertSenderOf(env, TenantAdminServer.ReadConfig(env), tenant, await store(), line => lines.push(line)), undefined)
            assert.equal(lines.length, 1)
            assert.ok(lines[0].includes(missing), lines[0])
            for (const value of values)
            {
                assert.ok(!lines[0].includes(value), 'the line carries no setting value')
            }
        })
    }

    it('a key file of the wrong length turns the advert off', async () =>
    {
        writeFileSync(keyFile, randomBytes(Names.KeyBytes - 1))
        const lines: string[] = []
        const env = advertEnv()
        assert.equal(TenantAdminServer.AdvertSenderOf(env, TenantAdminServer.ReadConfig(env), tenant, await store(), line => lines.push(line)), undefined)
        assert.equal(lines.length, 1)
        assert.ok(lines[0].includes(TenantAdminEnv.FingerprintKeyFile))
        assert.ok(!lines[0].includes(keyFile))
    })

    /** Drives one request through the composed plane's tenant API as the seeded Owner. */
    const handle = async (composition: TenantAdminComposition, method: string, body?: unknown): Promise<{ status: number; body: unknown }> =>
    {
        const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, headers: {} })
        let status = 0
        let text = ''
        const res = { writeHead: (s: number) => { status = s }, end: (b: string) => { text = b } }
        await composition.plane.api.Handle(req as unknown as IncomingMessage, res as unknown as ServerResponse, Names.EmailDomainsPath, session)
        return { status, body: JSON.parse(text) }
    }

    it('Compose opens the email domains from the seed when no file exists', async () =>
    {
        writeConsoleSeed()
        const lines: string[] = []
        const server = new TenantAdminServer(TenantAdminServer.ReadConfig(baseEnv()), new FakeRolloutClient())
        const composition = await server.Compose({}, undefined, line => lines.push(line))
        assert.deepEqual(composition.emailDomains.Domains, [Names.EmailDomain])
        assert.equal(existsSync(join(root, ConsoleEmailDomainStore.FileName)), false)
        assert.equal(composition.advert, undefined, 'no advert outside a configured console')
        assert.equal(lines.length, 1)
    })

    it('Compose mounts the email-domain route on the console plane', async () =>
    {
        writeConsoleSeed()
        const server = new TenantAdminServer(TenantAdminServer.ReadConfig(baseEnv()), new FakeRolloutClient())
        const composition = await server.Compose({}, undefined, () => undefined)
        assert.deepEqual(await handle(composition, Names.Get), { status: Names.Ok, body: { domains: [Names.EmailDomain], editable: true, inHive: true, pending: [] } })
    })

    it('Compose serves the desktop surface and its lookup, keeping the email-domain route', async () =>
    {
        writeConsoleSeed()
        const server = new TenantAdminServer(TenantAdminServer.ReadConfig(baseEnv()), new FakeRolloutClient())
        const composition = await server.Compose({}, undefined, () => undefined)
        assert.deepEqual(await DesktopProbe.Get(composition, Names.ConsolePath), { handled: true, status: Names.Ok, body: { tenantId: Names.TenantId, tenantName: Names.TenantName } })
        assert.deepEqual(await handle(composition, Names.Get), { status: Names.Ok, body: { domains: [Names.EmailDomain], editable: true, inHive: true, pending: [] } })
    })

    it('a PUT on the console route writes the console store and its file, never the seeded record', async () =>
    {
        writeConsoleSeed()
        const server = new TenantAdminServer(TenantAdminServer.ReadConfig(baseEnv()), new FakeRolloutClient())
        const composition = await server.Compose({}, undefined, () => undefined)
        const answer = await handle(composition, Names.Put, { domains: [Names.NewEmailDomain] })
        assert.deepEqual(answer, { status: Names.Ok, body: { domains: [Names.NewEmailDomain], editable: true, inHive: true, pending: [] } })
        assert.deepEqual(composition.emailDomains.Domains, [Names.NewEmailDomain])
        assert.deepEqual(JSON.parse(readFileSync(join(root, ConsoleEmailDomainStore.FileName), Names.Utf8)), { domains: [Names.NewEmailDomain] })
        assert.deepEqual(composition.directory.Tenant.emailDomains, [Names.EmailDomain], 'the seeded record is untouched')
        assert.deepEqual((JSON.parse(readFileSync(join(root, Names.SeedFile), Names.Utf8)) as { tenant: TenantRecord }).tenant.emailDomains, [Names.EmailDomain])
    })

    it('Close after a failed Listen is a no-op', async () =>
    {
        writeConsoleSeed()
        const url = await listenChannel()
        const blocker = createServer()
        await new Promise<void>(res => blocker.listen(0, Names.DefaultBind, () => res()))
        try
        {
            const env = { ...(await runEnv(url)), [Names.PortVar]: String((blocker.address() as AddressInfo).port) }
            const server = new TenantAdminServer(TenantAdminServer.ReadConfig(env), new FakeRolloutClient())
            await assert.rejects(() => server.Run(env, () => undefined))
            assert.equal(posts.length, 0, 'no advert from a console that never listened')
            await server.Close()
        }
        finally
        {
            await new Promise<void>(res => blocker.close(() => res()))
        }
    })

    it('Close aborts a send in flight and waits for it, with no late log', async () =>
    {
        writeConsoleSeed()
        const url = await listenChannel(1)
        const env = await runEnv(url)
        const lines: string[] = []
        const server = new TenantAdminServer(TenantAdminServer.ReadConfig(env), new FakeRolloutClient())
        const composition = await server.Run(env, line => lines.push(line))
        await composition.emailDomains.Set(Names.TenantId, [Names.NewEmailDomain])
        await Waits.Until(() => posts.length === 2)
        await server.Close()
        await Waits.Until(() => abandoned === 1)
        await new Promise<void>(res => setTimeout(res, Names.SettleMs))
        assert.deepEqual(lines.filter(l => l.includes(Names.SendFailed)), [], 'the aborted send is not reported')
    })

    it('an Owner reset in the advert answer ends the seeded Owner sessions and writes the applied marker', async () =>
    {
        writeConsoleSeed()
        // Sessions the console's own store holds before it starts: the Owner's (console and desktop) and someone else's.
        const before = ControlPlaneServer.TenantSessionsOf(root)
        const ownerConsole = await before.Issue(Names.TenantId, Names.PrincipalId, Names.OwnerEmail)
        const ownerDesktop = await before.Issue(Names.TenantId, Names.PrincipalId, Names.OwnerEmail, TenantSessionKind.Desktop)
        const other = await before.Issue(Names.TenantId, Names.OtherPrincipalId)
        await new Promise<void>(res => setTimeout(res, Names.TickMs))
        answerBody = JSON.stringify({ refusedEmailDomains: [], ownerResetAt: Names.OwnerResetAt })
        const url = await listenChannel()
        const env = await runEnv(url)
        const server = new TenantAdminServer(TenantAdminServer.ReadConfig(env), new FakeRolloutClient())
        await server.Run(env, () => undefined)
        try
        {
            assert.deepEqual(JSON.parse(readFileSync(join(root, ConsoleOwnerResetFollower.FileName), Names.Utf8)), { appliedAt: Names.OwnerResetAt })
            const after = ControlPlaneServer.TenantSessionsOf(root)
            assert.equal(await after.Validate(ownerConsole.id), null, 'the Owner console session is refused')
            assert.equal(await after.Validate(ownerDesktop.id), null, 'the Owner desktop session is refused')
            assert.notEqual(await after.Validate(other.id), null, 'another principal keeps its session')
        }
        finally
        {
            await server.Close()
        }
    })

    it('Run sends the advert after listening and Close stops it', async () =>
    {
        writeConsoleSeed()
        const url = await listenChannel()
        const env = await runEnv(url)
        const server = new TenantAdminServer(TenantAdminServer.ReadConfig(env), new FakeRolloutClient())
        const composition = await server.Run(env)
        try
        {
            assert.ok(composition.advert instanceof ConsoleAdvertSender)
            assert.equal(posts.length, 1)
            assert.equal(posts[0].url, Names.AdvertPath)
            assert.deepEqual((posts[0].body as { emailDomains: string[] }).emailDomains, [Names.EmailDomain])
            await composition.emailDomains.Set(Names.TenantId, [Names.NewEmailDomain])
            await Waits.Until(() => posts.length === 2)
            assert.deepEqual((posts[1].body as { emailDomains: string[] }).emailDomains, [Names.NewEmailDomain], 'a domain change is sent at once')
        }
        finally
        {
            await server.Close()
        }
        await composition.emailDomains.Set(Names.TenantId, [Names.EmailDomain])
        await new Promise<void>(res => setTimeout(res, Names.SettleMs))
        assert.equal(posts.length, 2, 'nothing more after Close')
        assert.equal(composition.emailDomains.Changed.subscriberCount, 0)
    })
})

describe('UnconfiguredRolloutClient', () =>
{
    it('fails closed on every method', async () =>
    {
        const client = new UnconfiguredRolloutClient()
        await assert.rejects(() => client.ManifestsFor(Names.TenantId), RolloutUnavailableError)
        await assert.rejects(() => client.StatusFor(Names.HiveId), RolloutUnavailableError)
        await assert.rejects(() => client.AdoptTarget(Names.HiveId, Names.Unused), RolloutUnavailableError)
    })

    it('TenantApiEndpoint answers 503 with a clear message for manifests and rollout status', async () =>
    {
        const hive = { id: Names.HiveId, tenantId: Names.TenantId }
        const directory = { GetHive: () => hive, GetTenant: () => undefined, ListHives: () => [hive] } as unknown as never
        const stub = {} as unknown as never
        const endpoint = new TenantApiEndpoint(stub, directory, new UnconfiguredRolloutClient(), new HiveOrchestratorFactory(), new EnvironmentPlacement(directory))
        const session: TenantSession = { id: 's', tenantId: Names.TenantId, principalId: 'p', expiresAt: Names.Expires }
        for (const path of [Names.ManifestsPath, Names.HivesPathPrefix + Names.HiveId + Names.RolloutPathSuffix])
        {
            let status = 0
            let body = ''
            const res = { writeHead: (s: number) => { status = s }, end: (b: string) => { body = b } }
            await endpoint.Handle({ method: Names.Get } as unknown as IncomingMessage, res as unknown as ServerResponse, path, session)
            assert.equal(status, Names.Unavailable)
            assert.match(body, Names.NoRolloutPattern)
        }
    })
})

describe('TenantAdminServer.RolloutClientFrom', () =>
{
    it('uses the unconfigured default when no rollout URL is set', () =>
    {
        assert.ok(TenantAdminServer.RolloutClientFrom({}) instanceof UnconfiguredRolloutClient)
    })

    it('builds the HTTP client when the URL, token and hive id are set', () =>
    {
        const client = TenantAdminServer.RolloutClientFrom({
            PRAGMATIC_TENANT_ADMIN_ROLLOUT_URL: 'http://channel.example:7000',
            PRAGMATIC_TENANT_ADMIN_ROLLOUT_TOKEN: 'tok',
            PRAGMATIC_TENANT_ADMIN_ROLLOUT_HIVE_ID: 'hive-a',
        })
        assert.ok(client instanceof HttpRolloutClient)
    })

    it('fails naming the variable when the URL is set without a token', () =>
    {
        assert.throws(
            () => TenantAdminServer.RolloutClientFrom({ PRAGMATIC_TENANT_ADMIN_ROLLOUT_URL: 'http://c:1', PRAGMATIC_TENANT_ADMIN_ROLLOUT_HIVE_ID: 'h' }),
            /PRAGMATIC_TENANT_ADMIN_ROLLOUT_TOKEN/)
    })
})

describe('TenantAdminServer.BuildIdpService', () =>
{
    it('selects the injected connection-only service when the issuer env is present, else the docker-backed one', () =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'tas-idp-'))
        try
        {
            const injected = TenantAdminServer.BuildIdpService({ PRAGMATIC_IDP_BROWSER_BASE_URL: 'https://b', PRAGMATIC_IDP_BASE_URL: 'https://i', PRAGMATIC_IDP_CA_FILE: '/ca', PRAGMATIC_IDP_ADMIN_TOKEN_FILE: '/t' }, dir)
            assert.ok(injected instanceof InjectedIdpService)
            assert.ok(TenantAdminServer.BuildIdpService({}, dir) instanceof IdpService)
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
