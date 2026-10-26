import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import type { HiveRecord, TenantRecord } from '../platform-records.js'
import { TenantAdminBootstrap } from '../tenant-admin-bootstrap.js'
import type { IHiveRegistrar, TenantBootstrapInput } from '../tenant-admin-bootstrap.js'

class FakeRegistrar implements IHiveRegistrar
{
    public static readonly Token = 'minted-one-time-agent-token'
    public readonly registered: string[] = []

    public async RegisterHive(hiveId: string): Promise<string>
    {
        this.registered.push(hiveId)
        return FakeRegistrar.Token
    }
}

class BootstrapFixture
{
    public static readonly PullJson = '{"auths":{"registry.example":{"auth":"cHVsbC1vbmx5LXNlY3JldA=="}}}'
    public static readonly TrustRootPem = '-----BEGIN PUBLIC KEY-----\nTRUSTROOT\n-----END PUBLIC KEY-----\n'

    public static Tenant(): TenantRecord
    {
        return {
            id: 'acme', clientId: 'c1', displayName: 'Acme', createdAt: '2026-01-01T00:00:00.000Z',
            ownerEmail: 'o@acme.test', ownerPrincipalId: 'owner', idpBaseUrl: 'https://old', idpCaRef: 'ca-ref', idpAdminTokenRef: 'tok-ref',
        }
    }

    public static Hive(): HiveRecord
    {
        return {
            id: 'hive-a', tenantId: 'acme', displayName: 'Hive A',
            cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Attach },
            trustRootRef: 'dev-signing', createdAt: '2026-01-01T00:00:00.000Z',
        }
    }

    public static Input(withPull: boolean = true): TenantBootstrapInput
    {
        const input: TenantBootstrapInput = {
            tenant: BootstrapFixture.Tenant(),
            hive: BootstrapFixture.Hive(),
            tenantAdminImage: 'pragmatic-server:dev',
            tenantPlanePort: 8443,
            baseDomain: 'tenants.test',
            externalScheme: 'https',
            channelUrl: 'http://channel.example:7000',
            idp: { image: 'pragmatic-server:dev', port: 9443, tlsSecretName: 'idp-tls', adminTokenSecretName: 'idp-admin', adminTokenRef: 'tok-ref' },
            trustRootPublicKey: BootstrapFixture.TrustRootPem,
        }
        if (withPull)
        {
            input.pullCredential = { secretName: 'pull-cred', dockerConfigJson: BootstrapFixture.PullJson }
        }
        return input
    }
}

describe('TenantAdminBootstrap.GenerateBootstrap', () =>
{
    it('mints exactly one agent token via the registrar for the hive', async () =>
    {
        const registrar = new FakeRegistrar()
        await new TenantAdminBootstrap(registrar).GenerateBootstrap(BootstrapFixture.Input())
        assert.deepEqual(registrar.registered, ['hive-a'])
    })

    it('emits the tenant + hive directory read-models as the seed, pointing the hive at its token Secret by name', async () =>
    {
        const b = await new TenantAdminBootstrap(new FakeRegistrar()).GenerateBootstrap(BootstrapFixture.Input())
        assert.equal(b.seed.tenant.id, 'acme')
        assert.equal(b.seed.hives.length, 1)
        assert.equal(b.seed.hives[0].id, 'hive-a')
        assert.equal(b.seed.hives[0].agentTokenRef, K8sManifestBuilder.AgentTokenSecretNameOf('hive-a'))
        assert.ok(!JSON.stringify(b.seed).includes(FakeRegistrar.Token))
    })

    it('assembles Namespace(s) first then agent, IdP and tenant-admin objects, with the shared namespace emitted once', async () =>
    {
        const b = await new TenantAdminBootstrap(new FakeRegistrar()).GenerateBootstrap(BootstrapFixture.Input())
        const items = JSON.parse(b.manifest).items as Array<{ kind: string; metadata: { name: string } }>
        assert.equal(items[0].kind, 'Namespace')
        assert.equal(items.filter(i => i.kind === 'Namespace' && i.metadata.name === 'pragmatic-system').length, 1)
        const kinds = new Set(items.map(i => i.kind))
        for (const k of ['Namespace', 'ServiceAccount', 'ClusterRole', 'ClusterRoleBinding', 'Deployment', 'Service', 'PersistentVolumeClaim'])
        {
            assert.ok(kinds.has(k), k)
        }
        const deployments = items.filter(i => i.kind === 'Deployment').map(i => i.metadata.name).sort()
        assert.deepEqual(deployments, [
            K8sManifestBuilder.HiveAgentNameOf('hive-a'),
            K8sManifestBuilder.IdpNameOf('acme'),
            K8sManifestBuilder.TenantAdminNameOf('acme'),
        ].sort())
    })

    it('the manifest carries secret REFS only: no Secret objects and no secret bytes', async () =>
    {
        const b = await new TenantAdminBootstrap(new FakeRegistrar()).GenerateBootstrap(BootstrapFixture.Input())
        const doc = JSON.parse(b.manifest)
        assert.ok(!doc.items.some((i: any) => i.kind === 'Secret'))
        assert.ok(!b.manifest.includes(FakeRegistrar.Token))
        assert.ok(!b.manifest.includes('pull-only-secret'))
        assert.ok(b.manifest.includes(K8sManifestBuilder.AgentTokenSecretNameOf('hive-a')))
        assert.ok(b.manifest.includes(K8sManifestBuilder.TenantAdminSeedSecretNameOf('acme')))
        assert.ok(b.manifest.includes('idp-tls'))
        assert.ok(b.manifest.includes('idp-admin'))
    })

    it('the Secrets set renders agent token, seed (seed.json, master.key, trust root) and pull credential into pragmatic-system', async () =>
    {
        const b = await new TenantAdminBootstrap(new FakeRegistrar()).GenerateBootstrap(BootstrapFixture.Input())
        const doc = JSON.parse(b.secrets.RenderManifest())
        const secrets = doc.items as Array<{ kind: string; type?: string; metadata: { name: string; namespace: string }; data: Record<string, string> }>
        assert.ok(secrets.every(s => s.kind === 'Secret' && s.metadata.namespace === 'pragmatic-system'))
        const byName = new Map(secrets.map(s => [s.metadata.name, s]))
        const token = byName.get(K8sManifestBuilder.AgentTokenSecretNameOf('hive-a'))!
        assert.equal(Buffer.from(token.data['token'], 'base64').toString('utf8'), FakeRegistrar.Token)
        const seed = byName.get(K8sManifestBuilder.TenantAdminSeedSecretNameOf('acme'))!
        assert.deepEqual(Object.keys(seed.data).sort(), ['master.key', 'seed.json', 'trust-root.pub'])
        assert.equal(Buffer.from(seed.data['master.key'], 'base64').length, 32)
        assert.deepEqual(JSON.parse(Buffer.from(seed.data['seed.json'], 'base64').toString('utf8')), JSON.parse(JSON.stringify(b.seed)))
        assert.equal(Buffer.from(seed.data['trust-root.pub'], 'base64').toString('utf8'), BootstrapFixture.TrustRootPem)
        const pull = byName.get('pull-cred')!
        assert.equal(pull.type, 'kubernetes.io/dockerconfigjson')
        assert.equal(Buffer.from(pull.data['.dockerconfigjson'], 'base64').toString('utf8'), BootstrapFixture.PullJson)
    })

    it('references the IdP Secrets from the IdP namespace and never emits them into pragmatic-system', async () =>
    {
        const b = await new TenantAdminBootstrap(new FakeRegistrar()).GenerateBootstrap(BootstrapFixture.Input())
        const idpNs = K8sManifestBuilder.IdpNameOf('acme')
        const items = JSON.parse(b.manifest).items as Array<{ kind: string; metadata: { name: string; namespace?: string } }>
        const idpDeployment = items.find(i => i.kind === 'Deployment' && i.metadata.name === idpNs)!
        assert.equal(idpDeployment.metadata.namespace, idpNs)
        const volumes = (idpDeployment as any).spec.template.spec.volumes.map((v: any) => v.secret?.secretName).filter(Boolean)
        assert.deepEqual(volumes.sort(), ['idp-admin', 'idp-tls'])
        assert.ok(!b.secrets.Names().some(n => n === 'idp-tls' || n === 'idp-admin'))
    })

    it('omits the pull credential Secret when none is supplied', async () =>
    {
        const b = await new TenantAdminBootstrap(new FakeRegistrar()).GenerateBootstrap(BootstrapFixture.Input(false))
        assert.deepEqual(b.secrets.Names().sort(), [K8sManifestBuilder.AgentTokenSecretNameOf('hive-a'), K8sManifestBuilder.TenantAdminSeedSecretNameOf('acme')].sort())
    })

    it('omits the IdP workload when none is supplied, and AddEntry extends a Secret', async () =>
    {
        const input = BootstrapFixture.Input(false)
        delete input.idp
        const b = await new TenantAdminBootstrap(new FakeRegistrar()).GenerateBootstrap(input)
        const names = (JSON.parse(b.manifest).items as Array<{ kind: string; metadata: { name: string } }>).filter(i => i.kind === 'Deployment').map(i => i.metadata.name)
        assert.ok(!names.includes(K8sManifestBuilder.IdpNameOf('acme')))
        b.secrets.AddEntry(K8sManifestBuilder.TenantAdminSeedSecretNameOf('acme'), 'extra.json', '{}')
        const seed = JSON.parse(b.secrets.RenderManifest()).items.find((s: any) => s.data['extra.json'] !== undefined)
        assert.equal(Buffer.from(seed.data['extra.json'], 'base64').toString('utf8'), '{}')
        assert.throws(() => b.secrets.AddEntry('nope', 'k', 'v'))
    })

    it('mints a distinct per-tenant master key each time', async () =>
    {
        const gen = new TenantAdminBootstrap(new FakeRegistrar())
        const key = (b: Awaited<ReturnType<TenantAdminBootstrap['GenerateBootstrap']>>): string =>
            JSON.parse(b.secrets.RenderManifest()).items.find((s: any) => s.data['master.key'] !== undefined).data['master.key']
        assert.notEqual(key(await gen.GenerateBootstrap(BootstrapFixture.Input())), key(await gen.GenerateBootstrap(BootstrapFixture.Input())))
    })

    it('never echoes secret values via JSON, string conversion or inspect of the bootstrap', async () =>
    {
        const b = await new TenantAdminBootstrap(new FakeRegistrar()).GenerateBootstrap(BootstrapFixture.Input())
        const masterKey = JSON.parse(b.secrets.RenderManifest()).items.find((s: any) => s.data['master.key'] !== undefined).data['master.key']
        const leaked = [JSON.stringify(b), String(b.secrets), inspect(b, { depth: 8 })].join('\n')
        assert.ok(!leaked.includes(FakeRegistrar.Token))
        assert.ok(!leaked.includes(Buffer.from(FakeRegistrar.Token).toString('base64')))
        assert.ok(!leaked.includes(masterKey))
        assert.ok(!leaked.includes('pull-only-secret'))
        assert.ok(!leaked.includes(Buffer.from(BootstrapFixture.PullJson).toString('base64')))
    })
})

describe('TenantAdminBootstrap in-cluster IdP federation producer', () =>
{
    const CaPem = '-----BEGIN CERTIFICATE-----\nCAONLY\n-----END CERTIFICATE-----\n'

    async function Federated()
    {
        const input = BootstrapFixture.Input()
        input.idp = { ...input.idp!, ca: Buffer.from(CaPem), adminToken: 'idp-admin-token-value' }
        return new TenantAdminBootstrap(new FakeRegistrar()).GenerateBootstrap(input)
    }

    function AdminDeployment(manifest: string): any
    {
        const items = (JSON.parse(manifest) as { items: any[] }).items
        return items.find(i => i.kind === 'Deployment' && i.metadata.name === K8sManifestBuilder.TenantAdminNameOf('acme'))
    }

    it('populates spec.idp with browser/internal bases and ca-only + admin-token Secret refs', async () =>
    {
        const b = await Federated()
        const dep = AdminDeployment(b.manifest)
        const env = dep.spec.template.spec.containers[0].env as { name: string; value?: string }[]
        assert.ok(env.some(e => e.value === K8sManifestBuilder.IdpBrowserUrlOf('acme', 'tenants.test')))
        assert.ok(env.some(e => e.value === K8sManifestBuilder.IdpBaseUrlOf('acme', 9443)))
        const secretVolumes = dep.spec.template.spec.volumes.map((v: any) => v.secret?.secretName).filter(Boolean)
        assert.ok(secretVolumes.includes(TenantAdminBootstrap.IdpCaSecretNameOf('acme')))
        assert.ok(secretVolumes.includes(TenantAdminBootstrap.IdpTokenSecretNameOf('acme')))
    })

    it('projects a ca.crt-only Secret and never references the IdP TLS Secret from the pod', async () =>
    {
        const b = await Federated()
        const list = JSON.parse(b.secrets.RenderManifest()) as { items: { metadata: { name: string }; data: Record<string, string> }[] }
        const ca = list.items.find(i => i.metadata.name === TenantAdminBootstrap.IdpCaSecretNameOf('acme'))!
        assert.deepEqual(Object.keys(ca.data), ['ca.crt'])
        assert.equal(Buffer.from(ca.data['ca.crt'], 'base64').toString(), CaPem)
        const dep = AdminDeployment(b.manifest)
        const volumes = dep.spec.template.spec.volumes.map((v: any) => v.secret?.secretName).filter(Boolean)
        assert.ok(!volumes.includes('idp-tls'))
        assert.ok(!JSON.stringify(dep).includes('server.key'))
        assert.ok(!JSON.stringify(dep).includes('server.crt'))
    })

    it('leaves spec.idp unset when no IdP material is supplied', async () =>
    {
        const b = await new TenantAdminBootstrap(new FakeRegistrar()).GenerateBootstrap(BootstrapFixture.Input())
        assert.ok(!b.secrets.Names().includes(TenantAdminBootstrap.IdpCaSecretNameOf('acme')))
    })
})
