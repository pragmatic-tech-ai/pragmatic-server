import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { InClusterIdpDriver } from '../in-cluster-idp-driver.js'
import type { IIdpSeedSource, IdpSeed } from '../in-cluster-idp-driver.js'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import { IdpStatus } from '../idp-record.js'
import type { IKubectl } from '../kubectl.js'

class FakeKubectl implements IKubectl
{
    public Applied: string[] = []
    public Rollouts: string[] = []
    public FailApply = false

    public async Apply(manifestJson: string): Promise<void>
    {
        if (this.FailApply)
        {
            throw new Error('apply failed')
        }
        this.Applied.push(manifestJson)
    }

    public async RolloutStatus(namespace: string, deployment: string): Promise<void>
    {
        this.Rollouts.push(`${namespace}/${deployment}`)
    }

    public async SetImage(): Promise<void> { }
    public async Scale(): Promise<void> { }
    public async ScaleStatefulSet(): Promise<void> { }
    public async RolloutRestart(): Promise<void> { }
    public async Get(): Promise<string> { return '' }
    public async DeleteNamespace(): Promise<void> { }
}

class FakeSeeds implements IIdpSeedSource
{
    public static readonly Token = 'seeded-token-VALUE'
    public static readonly Ca = 'seeded-ca-BYTES'

    public constructor(public readonly BaseDomain?: string)
    {
    }

    public SeedFor(): IdpSeed
    {
        return {
            caRef: 'idp-tls-secret', adminTokenRef: 'admin-token', tlsSecretName: 'idp-tls-secret', adminTokenSecretName: 'idp-admin-secret',
            ca: Buffer.from(FakeSeeds.Ca), adminToken: FakeSeeds.Token
        }
    }
}

describe('InClusterIdpDriver', () =>
{
    const Make = (kubectl: FakeKubectl) => new InClusterIdpDriver(kubectl, new K8sManifestBuilder(), new FakeSeeds(), 'hive-a', 'pragmatic-server:dev')

    it('browserBaseUrl is the idp-<tenant>.<baseDomain> origin when the seed source carries a baseDomain', async () =>
    {
        // baseDomain is owned by the seed source (the cert-minting authority); the driver reads it from there,
        // so the advertised browser host and the cert SANs can never diverge.
        const driver = new InClusterIdpDriver(new FakeKubectl(), new K8sManifestBuilder(), new FakeSeeds('d.localtest'), 'hive-a', 'img')
        const result = await driver.EnsureRunning({ tenantId: 't1', displayName: 'T', takenPorts: [] })
        assert.equal(result.connection.browserBaseUrl, 'https://idp-t1.d.localtest')
        assert.equal(result.connection.baseUrl, K8sManifestBuilder.IdpBaseUrlOf('t1', 9443))
    })

    it('browserBaseUrl equals the internal baseUrl when no baseDomain is set', async () =>
    {
        const result = await Make(new FakeKubectl()).EnsureRunning({ tenantId: 't1', displayName: 'T', takenPorts: [] })
        assert.equal(result.connection.browserBaseUrl, result.connection.baseUrl)
    })

    it('applies the rendered IdP workload, waits for rollout, and returns the in-cluster service DNS baseUrl', async () =>
    {
        const kubectl = new FakeKubectl()
        const result = await Make(kubectl).EnsureRunning({ tenantId: 't1', displayName: 'T', takenPorts: [] })
        assert.equal(kubectl.Applied.length, 1)
        assert.equal(kubectl.Rollouts.length, 1)
        assert.ok(result.connection.baseUrl.endsWith('.svc.cluster.local:9443'))
        assert.ok(!result.connection.baseUrl.includes('host.docker.internal'))
        assert.equal(result.connection.baseUrl, K8sManifestBuilder.IdpBaseUrlOf('t1', 9443))
        assert.equal(result.record.status, IdpStatus.Running)
        assert.equal(result.record.baseUrl, result.connection.baseUrl)
    })

    it('uses the seeded refs and material rather than minting; manifest holds no secret material', async () =>
    {
        const kubectl = new FakeKubectl()
        const result = await Make(kubectl).EnsureRunning({ tenantId: 't1', displayName: 'T', takenPorts: [] })
        assert.equal(result.connection.adminTokenRef, 'admin-token')
        assert.equal(result.connection.caDir, 'idp-tls-secret')
        assert.equal(result.connection.adminToken, FakeSeeds.Token)
        assert.equal(result.connection.ca.toString(), FakeSeeds.Ca)
        assert.ok(!kubectl.Applied[0]!.includes(FakeSeeds.Token))
        assert.ok(!kubectl.Applied[0]!.includes(FakeSeeds.Ca))
    })

    it('replaces a stale (docker) existing record but returns a matching one as-is', async () =>
    {
        const driver = Make(new FakeKubectl())
        const first = await driver.EnsureRunning({ tenantId: 't1', displayName: 'T', takenPorts: [] })
        const same = await driver.EnsureRunning({ tenantId: 't1', displayName: 'T', takenPorts: [], existing: first.record })
        assert.equal(same.record, first.record)
        const stale = { ...first.record, baseUrl: 'https://host.docker.internal:12100', port: 12100 }
        const rebuilt = await driver.EnsureRunning({ tenantId: 't1', displayName: 'T', takenPorts: [], existing: stale })
        assert.notEqual(rebuilt.record, stale)
        assert.equal(rebuilt.record.baseUrl, first.record.baseUrl)
        assert.equal(rebuilt.record.createdAt, stale.createdAt)
    })

    it('apply failure surfaces a fixed message without secret material', async () =>
    {
        const kubectl = new FakeKubectl()
        kubectl.FailApply = true
        await assert.rejects(() => Make(kubectl).EnsureRunning({ tenantId: 't1', displayName: 'T', takenPorts: [] }),
            (e: Error) => e.message.includes('t1') && !e.message.includes(FakeSeeds.Token) && !e.message.includes(FakeSeeds.Ca))
    })
})
