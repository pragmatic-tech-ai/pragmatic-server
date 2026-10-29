import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OciRegistryClient } from '../oci-registry-client.js'
import { FileKeyStore } from '../key-store.js'
import { UiArtifactSigner, UiArtifactVerifier } from '../ui-artifact-signer.js'
import { UiArtifact } from '../ui-artifact.js'
import { UiDeployActuator, UiDeployError } from '../ui-deploy-actuator.js'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import { EnvServerSeedSource } from '../env-server-seed.js'
import { EnvStatus, EnvType, Template } from '../environment-record.js'
import type { EnvironmentRecord } from '../environment-record.js'
import type { HiveRecord } from '../platform-records.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import type { IKubectl } from '../kubectl.js'
import type { IHiveOrchestrator } from '../hive-orchestrator.js'

class FakeOci extends OciRegistryClient
{
    public readonly Blobs = new Map<string, Uint8Array>()
    public readonly Manifests = new Map<string, Uint8Array>()

    public constructor(private readonly events: string[])
    {
        super('http://unused')
    }

    public override async PushBlob(_repo: string, bytes: Uint8Array): Promise<string>
    {
        const digest = OciRegistryClient.DigestOf(bytes)
        this.Blobs.set(digest, bytes)
        this.events.push('blob')
        return digest
    }

    public override async PushManifest(_repo: string, reference: string, manifestBytes: Uint8Array): Promise<string>
    {
        this.Manifests.set(reference, manifestBytes)
        this.events.push('manifest:' + reference)
        return OciRegistryClient.DigestOf(manifestBytes)
    }
}

class FakeKubectl implements IKubectl
{
    public readonly Applied: string[] = []
    public readonly Restarts: Array<[string, string]> = []

    public constructor(private readonly events: string[])
    {
    }

    public async Apply(manifestJson: string): Promise<void>
    {
        this.Applied.push(manifestJson)
        this.events.push('apply')
    }

    public async RolloutRestart(namespace: string, deployment: string): Promise<void>
    {
        this.Restarts.push([namespace, deployment])
        this.events.push('restart')
    }

    public StatusFails = false
    public Statuses: Array<[string, string]> = []

    public async RolloutStatus(namespace: string, deployment: string): Promise<void>
    {
        this.Statuses.push([namespace, deployment])
        this.events.push('status')
        if (this.StatusFails)
        {
            throw new Error('planted-rollout-detail')
        }
    }

    public async SetImage(): Promise<void> { }
    public async Scale(): Promise<void> { }
    public async ScaleStatefulSet(): Promise<void> { }
    public async Get(): Promise<string> { return '' }
    public async DeleteNamespace(): Promise<void> { }
}

class Fixture
{
    public static readonly Ref = 'hive-root'
    public static readonly Env = 'dev1'
    public static readonly App = 'Crm'
    public static readonly Version = '1.0.0'

    public dir = ''
    public events: string[] = []
    public oci!: FakeOci
    public kubectl!: FakeKubectl
    public puts: EnvironmentRecord[] = []
    public publicPem = ''
    public actuator!: UiDeployActuator

    public async Setup(): Promise<void>
    {
        this.dir = await mkdtemp(join(tmpdir(), 'ui-deploy-'))
        const pair = generateKeyPairSync('ed25519')
        this.publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }) as string
        await writeFile(join(this.dir, Fixture.Ref + FileKeyStore.PublicSuffix), this.publicPem)
        await writeFile(join(this.dir, Fixture.Ref + FileKeyStore.PrivateSuffix), pair.privateKey.export({ type: 'pkcs8', format: 'pem' }))
        this.events = []
        this.puts = []
        this.oci = new FakeOci(this.events)
        this.kubectl = new FakeKubectl(this.events)
        const keys = new FileKeyStore(this.dir)
        const orchestrator = { Kubectl: this.kubectl } as unknown as IHiveOrchestrator
        this.actuator = new UiDeployActuator(this.oci, new UiArtifactSigner(keys), keys, { For: () => orchestrator }, new K8sManifestBuilder(),
            { Put: async r => { this.puts.push(r); this.events.push('put') } })
    }

    public async Teardown(): Promise<void>
    {
        await rm(this.dir, { recursive: true, force: true })
    }

    public Hive(trustRootRef: string | undefined): HiveRecord
    {
        return { id: 'hive-a', tenantId: 'Tenant1', displayName: 'h', cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Provision }, trustRootRef, createdAt: 'x' }
    }

    public Record(): EnvironmentRecord
    {
        return { name: Fixture.Env, type: EnvType.Development, template: Template.DevBlank, environmentId: 'env-id', hiveId: 'hive-a', hostPort: 0, createdAt: 'x', status: EnvStatus.Running }
    }

    public Bundle()
    {
        return { config: { appName: Fixture.App, appVersion: Fixture.Version, entry: 'index.html', assets: ['index.html'] }, files: [{ path: 'index.html', bytes: new TextEncoder().encode('page') }] }
    }
}

describe('UiDeployActuator', () =>
{
    const fx = new Fixture()
    beforeEach(() => fx.Setup())
    afterEach(() => fx.Teardown())

    it('pushes blobs then manifest then a verifiable signature companion', async () =>
    {
        const rec = await fx.actuator.DeployAppToEnvironment(fx.Record(), fx.Hive(Fixture.Ref), fx.Bundle())
        const tag = 'Crm-1.0.0'
        assert.deepEqual(fx.events.slice(0, 3), ['blob', 'blob', 'manifest:' + tag])
        const packed = UiArtifact.Pack(fx.Bundle().config, fx.Bundle().files)
        assert.deepEqual(fx.oci.Manifests.get(tag), packed.manifestBytes)
        assert.equal(rec.appDeployment?.manifestDigest, OciRegistryClient.DigestOf(fx.oci.Manifests.get(tag)!))
        const sigManifest = JSON.parse(new TextDecoder().decode(fx.oci.Manifests.get(tag + UiArtifact.SignatureTagSuffix)))
        assert.equal(sigManifest.layers.length, 1)
        assert.equal(sigManifest.layers[0].mediaType, UiArtifact.SignatureMediaType)
        const sig = new TextDecoder().decode(fx.oci.Blobs.get(sigManifest.layers[0].digest))
        await new UiArtifactVerifier(new FileKeyStore(fx.dir)).Verify('Crm', '1.0.0', rec.appDeployment!.manifestDigest, sig, Fixture.Ref)
    })

    it('projects a trust Secret carrying only the public key', async () =>
    {
        await fx.actuator.DeployAppToEnvironment(fx.Record(), fx.Hive(Fixture.Ref), fx.Bundle())
        const secret = JSON.parse(fx.kubectl.Applied[0])
        assert.equal(secret.metadata.name, EnvServerSeedSource.UiTrustSecretNameOf(Fixture.Env))
        assert.deepEqual(Object.keys(secret.data), [Fixture.Ref + '.pub'])
        assert.equal(Buffer.from(secret.data[Fixture.Ref + '.pub'], 'base64').toString('utf8'), fx.publicPem)
    })

    it('records and persists appDeployment', async () =>
    {
        const rec = await fx.actuator.DeployAppToEnvironment(fx.Record(), fx.Hive(Fixture.Ref), fx.Bundle())
        assert.deepEqual(rec.appDeployment, { appName: 'Crm', appVersion: '1.0.0', repo: 'tenant1/crm', artifactTag: 'Crm-1.0.0', manifestDigest: rec.appDeployment!.manifestDigest })
        assert.equal(fx.puts.length, 1)
        assert.deepEqual(fx.puts[0], rec)
    })

    it('restarts the env Deployment after the record Put and manifest re-apply', async () =>
    {
        await fx.actuator.DeployAppToEnvironment(fx.Record(), fx.Hive(Fixture.Ref), fx.Bundle())
        assert.deepEqual(fx.kubectl.Restarts, [[K8sManifestBuilder.NamespaceOf(Fixture.Env), K8sManifestBuilder.ServerDeploymentOf(Fixture.Env)]])
        const tail = fx.events.slice(fx.events.indexOf('put'))
        assert.deepEqual(tail, ['put', 'apply', 'restart', 'status'])
        assert.ok(fx.kubectl.Applied[1].includes('PRAGMATIC_UI_REPO'), 'rendered manifest carries the unpack init container')
    })

    it('awaits rollout status on the env Deployment after the restart', async () =>
    {
        await fx.actuator.DeployAppToEnvironment(fx.Record(), fx.Hive(Fixture.Ref), fx.Bundle())
        assert.deepEqual(fx.kubectl.Statuses, [[K8sManifestBuilder.NamespaceOf(Fixture.Env), K8sManifestBuilder.ServerDeploymentOf(Fixture.Env)]])
    })

    it('rejects material-free when the rollout never becomes healthy', async () =>
    {
        fx.kubectl.StatusFails = true
        await assert.rejects(fx.actuator.DeployAppToEnvironment(fx.Record(), fx.Hive(Fixture.Ref), fx.Bundle()),
            (e: Error) => e instanceof UiDeployError && e.message === UiDeployError.RolloutFailedMessage && !e.message.includes('planted'))
    })

    it('fails fast without a trustRootRef and touches nothing', async () =>
    {
        for (const ref of [undefined, ''])
        {
            await assert.rejects(fx.actuator.DeployAppToEnvironment(fx.Record(), fx.Hive(ref), fx.Bundle()), (e: Error) => e instanceof UiDeployError && e.message === UiDeployError.NoTrustRootMessage)
        }
        assert.deepEqual(fx.events, [])
    })
})
