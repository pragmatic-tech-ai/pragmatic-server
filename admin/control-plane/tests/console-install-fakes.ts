import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConsoleFingerprintKeys } from '../console-fingerprint-keys.js'
import type { IDevCertificateIssuer, IssuedCertificate } from '../dev-certificate-authority.js'
import type { EnvironmentWorkload } from '../environment-workload.js'
import type { IHiveOrchestrator, WorkloadHealth } from '../hive-orchestrator.js'
import { InClusterIdpSeedSource } from '../in-cluster-idp-seed.js'
import { IngressTlsSource } from '../ingress-tls.js'
import type { IInHiveIdpAdmin, InHiveOwnerPassword } from '../in-hive-idp-admin.js'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import type { IKeyStore } from '../key-store.js'
import type { IKubectl } from '../kubectl.js'
import type { VerifiedImage } from '../pinned-image-verifier.js'
import { HiveBackend, InfraMode, type HiveRecord, type TenantRecord } from '../platform-records.js'
import { SealedSecretStore } from '../sealed-secret-store.js'
import { TenantAdminBootstrap, type IHiveRegistrar } from '../tenant-admin-bootstrap.js'
import { TenantConsoleInstaller, type IConsoleDirectory, type IConsoleImageApproval } from '../tenant-console-installer.js'

type ManifestItem = { kind?: string; metadata?: { name?: string; namespace?: string }; data?: Record<string, string> }

/** A cluster as the console installer sees it: objects by namespace + resource, every call logged (also into a shared event log). */
export class ConsoleFakeKubectl implements IKubectl
{
    public readonly Calls: string[][] = []
    public readonly Applied: string[] = []
    public readonly ServerApplied: string[] = []
    public readonly Deleted: string[] = []
    public readonly Objects = new Map<string, string>()
    /** Builds the error the n-th (0-based) server-side apply throws. */
    public ServerApplyFail: { at: number; error: () => Promise<Error> } | undefined
    public DeleteManifestError: Error | undefined
    /** Awaited by every Find while set: keeps an install in its first step. */
    public Hold: Promise<void> | undefined
    /** Namespaces as the API lists them: name -> labels. */
    public readonly Namespaces = new Map<string, Record<string, string>>()
    public readonly FailNamespaceDelete = new Set<string>()

    public constructor(private readonly events: string[] = [])
    {
    }

    public static Key(namespace: string, resource: string): string
    {
        return namespace + '|' + resource
    }

    public Put(namespace: string, resource: string, doc: unknown): void
    {
        this.Objects.set(ConsoleFakeKubectl.Key(namespace, resource), JSON.stringify(doc))
    }

    public async Find(namespace: string, resource: string): Promise<string | undefined>
    {
        this.Calls.push(['Find', namespace, resource])
        if (this.Hold !== undefined)
        {
            await this.Hold
        }
        return this.Objects.get(ConsoleFakeKubectl.Key(namespace, resource))
    }

    public async Apply(manifestJson: string): Promise<void>
    {
        this.Calls.push(['Apply'])
        this.Applied.push(manifestJson)
    }

    public async ApplyServerSide(manifestJson: string): Promise<void>
    {
        const index = this.ServerApplied.length
        this.Calls.push(['ApplyServerSide'])
        this.ServerApplied.push(manifestJson)
        if (this.ServerApplyFail !== undefined && this.ServerApplyFail.at === index)
        {
            throw await this.ServerApplyFail.error()
        }
        for (const item of ConsoleFakeKubectl.ItemsOf(manifestJson))
        {
            if (item.kind === 'Secret' && item.metadata?.name !== undefined && item.metadata.namespace !== undefined)
            {
                this.Put(item.metadata.namespace, 'secret/' + item.metadata.name, item)
            }
        }
    }

    public async DeleteManifest(manifestJson: string): Promise<void>
    {
        this.Calls.push(['DeleteManifest', manifestJson])
        this.Deleted.push(manifestJson)
        this.events.push('DeleteManifest')
        if (this.DeleteManifestError !== undefined)
        {
            throw this.DeleteManifestError
        }
    }

    public async DeleteNamespacesBySelector(selector: string, namePrefix: string): Promise<string[]>
    {
        this.Calls.push(['DeleteNamespacesBySelector', selector, namePrefix])
        this.events.push('DeleteNamespacesBySelector')
        const [key, value] = selector.split('=')
        const failed: string[] = []
        for (const [name, labels] of [...this.Namespaces])
        {
            if (labels[key as string] !== value || !name.startsWith(namePrefix))
            {
                continue
            }
            if (this.FailNamespaceDelete.has(name))
            {
                failed.push(name)
                continue
            }
            this.Namespaces.delete(name)
        }
        return failed
    }

    public async ListNamespacesBySelector(selector: string, namePrefix: string): Promise<string[]>
    {
        this.Calls.push(['ListNamespacesBySelector', selector, namePrefix])
        const [key, value] = selector.split('=')
        return [...this.Namespaces].filter(([name, labels]) => labels[key as string] === value && name.startsWith(namePrefix)).map(([name]) => name)
    }

    public async RolloutRestart(n: string, d: string): Promise<void> { this.Calls.push(['RolloutRestart', n, d]) }
    public RolloutStatusError: Error | undefined

    public async RolloutStatus(n: string, d: string): Promise<void>
    {
        this.Calls.push(['RolloutStatus', n, d])
        if (this.RolloutStatusError !== undefined)
        {
            throw this.RolloutStatusError
        }
    }
    public async DeleteBySelector(n: string, r: string, s: string): Promise<void> { this.Calls.push(['DeleteBySelector', n, r, s]); this.events.push('DeleteBySelector') }
    public async RolloutRestartSelector(n: string, s: string): Promise<void> { this.Calls.push(['RolloutRestartSelector', n, s]) }
    public async SetImage(_n: string, _d: string, _c: string, _i: string): Promise<void> { }
    public async Scale(_n: string, _d: string, _r: number): Promise<void> { }
    public async ScaleStatefulSet(_n: string, _s: string, _r: number): Promise<void> { }
    public async Get(_n: string, _r: string): Promise<string> { return '{}' }
    public async DeleteNamespace(n: string): Promise<void> { this.Calls.push(['DeleteNamespace', n]) }

    /** The calls that change the cluster or the run (Find excluded), as their verbs. */
    public Verbs(): string[]
    {
        return this.Calls.filter(c => c[0] !== 'Find').map(c => c[0] as string)
    }

    private static ItemsOf(manifestJson: string): ManifestItem[]
    {
        const parsed = JSON.parse(manifestJson) as { kind?: string; items?: ManifestItem[] }
        return parsed.kind === 'List' ? parsed.items ?? [] : [parsed as ManifestItem]
    }
}

export class ConsoleFakeOrchestrators
{
    public constructor(public readonly Kubectl: IKubectl)
    {
    }

    public For(_hive: HiveRecord): IHiveOrchestrator
    {
        const kubectl = this.Kubectl
        return {
            Kubectl: kubectl,
            Apply: async (_w: EnvironmentWorkload) => undefined,
            WaitHealthy: async (_w: EnvironmentWorkload) => undefined,
            Health: async (_w: EnvironmentWorkload): Promise<WorkloadHealth> => ({ ready: true, runningImage: undefined, detail: '' }),
            Roll: async (_w: EnvironmentWorkload, _i: string) => undefined,
            Scale: async (_w: EnvironmentWorkload, _r: number) => undefined,
            ScaleDatabase: async (_w: EnvironmentWorkload, _r: number) => undefined,
            Teardown: async (_w: EnvironmentWorkload) => undefined,
            PrepareAgent: async (_i: string) => undefined,
        }
    }
}

export class FakeInHiveIdpAdmin implements IInHiveIdpAdmin
{
    public static readonly Password = 'in-hive-owner-Zq.9'
    public readonly Remembered: Array<{ tenantId: string; ca: Buffer; adminToken: string }> = []
    public readonly Seeded: string[] = []
    public readonly Forgotten: string[] = []
    public SeedError: Error | undefined

    public constructor(private readonly events: string[] = [], private readonly calls: string[][] | undefined = undefined)
    {
    }

    public async Remember(tenantId: string, ca: Buffer, adminToken: string): Promise<void>
    {
        this.calls?.push(['Remember', tenantId])
        this.Remembered.push({ tenantId, ca, adminToken })
    }

    public async SeedOwner(hive: HiveRecord, _tenant: TenantRecord): Promise<void>
    {
        this.calls?.push(['SeedOwner', hive.id])
        if (this.SeedError !== undefined)
        {
            throw this.SeedError
        }
        this.Seeded.push(hive.id)
    }

    public ResetError: Error | undefined

    public async ResetOwnerPassword(_hive: HiveRecord, tenant: TenantRecord): Promise<InHiveOwnerPassword>
    {
        if (this.ResetError !== undefined)
        {
            throw this.ResetError
        }
        return { ownerEmail: tenant.ownerEmail ?? '', ownerPassword: FakeInHiveIdpAdmin.Password }
    }

    /** Tenants whose IdP credentials are sealed (a completed earlier install remembered them). */
    public readonly Sealed = new Set<string>()

    public async Holds(tenantId: string): Promise<boolean>
    {
        return this.Sealed.has(tenantId) || this.Remembered.some(r => r.tenantId === tenantId)
    }

    public async Forget(tenantId: string): Promise<void>
    {
        this.events.push('Forget')
        this.Forgotten.push(tenantId)
    }
}

export class FakeDevCa implements IDevCertificateIssuer
{
    public static readonly KeyPem = '-----BEGIN PRIVATE KEY-----\nfake.dev.leaf.key.Zq\n-----END PRIVATE KEY-----\n'
    public readonly Issued: Array<{ baseDomain: string; hosts: readonly string[] }> = []

    public async EnsureCa(_baseDomain: string): Promise<Buffer>
    {
        return Buffer.from('CA')
    }

    public async Issue(baseDomain: string, hosts: readonly string[]): Promise<IssuedCertificate>
    {
        this.Issued.push({ baseDomain, hosts: [...hosts] })
        return { cert: Buffer.from('-----BEGIN CERTIFICATE-----\nleaf\n-----END CERTIFICATE-----\n'), key: Buffer.from(FakeDevCa.KeyPem) }
    }

    public CaFileOf(baseDomain: string): string
    {
        return '/data/dev-ca/' + baseDomain + '/ca.crt'
    }
}

export class FakeImageApproval implements IConsoleImageApproval
{
    public readonly Approved: string[] = []

    public async Approve(hive: HiveRecord, baseImage: string): Promise<VerifiedImage>
    {
        this.Approved.push(hive.id + ':' + baseImage)
        return { imageRef: baseImage }
    }
}

export class FakeTrustRoots implements IKeyStore
{
    public async PublicKey(_ref: string): Promise<string>
    {
        return '-----BEGIN PUBLIC KEY-----\ntrust\n-----END PUBLIC KEY-----\n'
    }

    public async PrivateKey(_ref: string): Promise<string>
    {
        throw new Error('no private keys here')
    }
}

export class CountingRegistrar implements IHiveRegistrar
{
    public Calls = 0

    public async RegisterHive(_hiveId: string): Promise<string>
    {
        this.Calls++
        return 'agent-token-must-not-be-minted'
    }
}

/** A Local hive h1 of tenant acme with development console settings, its agent installed, and a real sealed store. */
export class ConsoleInstallFixture
{
    public static readonly ChannelUrl = 'http://host.docker.internal:7001'
    public static readonly BaseDomain = 'localtest.me'
    /** The admin token of the IdP that already runs in the cluster (reused, never re-minted). */
    public static readonly RunningIdpToken = 'running.idp.admin.token.Zq'
    public static readonly RunningIdpCa = '-----BEGIN CERTIFICATE-----\nrunning-idp-ca\n-----END CERTIFICATE-----\n'

    public readonly Events: string[] = []
    public readonly Hives = new Map<string, HiveRecord>()
    public readonly Tenants = new Map<string, TenantRecord>()
    public readonly Kubectl = new ConsoleFakeKubectl(this.Events)
    public readonly Orchestrators = new ConsoleFakeOrchestrators(this.Kubectl)
    public readonly IdpAdmin = new FakeInHiveIdpAdmin(this.Events, this.Kubectl.Calls)
    public readonly DevCa = new FakeDevCa()
    public readonly Images = new FakeImageApproval()
    public readonly Registrar = new CountingRegistrar()
    public readonly Installer: TenantConsoleInstaller

    private constructor(private readonly dir: string, public readonly Fingerprints: ConsoleFingerprintKeys, channelOn: boolean)
    {
        this.Installer = new TenantConsoleInstaller(
            { GetHive: (id: string) => this.Hives.get(id), GetTenant: (id: string) => this.Tenants.get(id) },
            this.Orchestrators,
            new TenantAdminBootstrap(this.Registrar),
            Fingerprints,
            this.DevCa,
            this.IdpAdmin,
            this.Images,
            new FakeTrustRoots(),
            channelOn ? ConsoleInstallFixture.ChannelUrl : undefined,
            { Now: () => Date.parse('2026-11-05T10:00:00.000Z'), Delay: async () => undefined })
        this.Tenants.set('acme', { id: 'acme', clientId: 'c1', displayName: 'Acme', createdAt: '2026-01-01T00:00:00.000Z', ownerEmail: 'owner@acme.test', ownerPrincipalId: 'owner' })
        this.Hives.set('h1', ConsoleInstallFixture.Hive('h1'))
        this.Kubectl.Put(K8sManifestBuilder.SystemNamespace, 'secret/' + K8sManifestBuilder.AgentTokenSecretNameOf('h1'), { data: { token: 'eA==' } })
    }

    public static async Create(options: { channelOn?: boolean; runningIdp?: boolean } = {}): Promise<ConsoleInstallFixture>
    {
        const dir = mkdtempSync(join(tmpdir(), 'console-install-'))
        const store = await SealedSecretStore.Open(join(dir, SealedSecretStore.FileName), randomBytes(32))
        const fx = new ConsoleInstallFixture(dir, new ConsoleFingerprintKeys(store), options.channelOn ?? true)
        if (options.runningIdp ?? true)
        {
            fx.SeedRunningIdp()
        }
        return fx
    }

    public static Hive(id: string, tenantId: string = 'acme'): HiveRecord
    {
        return {
            id, tenantId, displayName: id, cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Attach, endpoint: '' },
            createdAt: '2026-01-01T00:00:00.000Z', trustRootRef: 'platform-signing',
            console: { baseDomain: ConsoleInstallFixture.BaseDomain, tls: { source: IngressTlsSource.Development } },
        }
    }

    /** The IdP Secrets an earlier install left in the IdP namespace. */
    public SeedRunningIdp(tenantId: string = 'acme'): void
    {
        const ns = K8sManifestBuilder.IdpNameOf(tenantId)
        this.Kubectl.Put(ns, 'secret/' + InClusterIdpSeedSource.TlsSecretNameOf(tenantId), { data: { 'ca.crt': Buffer.from(ConsoleInstallFixture.RunningIdpCa).toString('base64') } })
        this.Kubectl.Put(ns, 'secret/' + InClusterIdpSeedSource.AdminSecretNameOf(tenantId), { data: { 'admin-token': Buffer.from(ConsoleInstallFixture.RunningIdpToken).toString('base64') } })
    }

    /** Another installer over the same fakes and store, reading hives and tenants from `directory` (a host test's PlatformDirectory). */
    public InstallerOver(directory: IConsoleDirectory): TenantConsoleInstaller
    {
        return new TenantConsoleInstaller(directory, this.Orchestrators, new TenantAdminBootstrap(this.Registrar), this.Fingerprints, this.DevCa,
            this.IdpAdmin, this.Images, new FakeTrustRoots(), ConsoleInstallFixture.ChannelUrl)
    }

    public Dispose(): void
    {
        rmSync(this.dir, { recursive: true, force: true })
    }
}
