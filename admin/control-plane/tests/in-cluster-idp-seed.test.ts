import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { X509Certificate } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InClusterIdpDriver } from '../in-cluster-idp-driver.js'
import { InClusterIdpSeedSource } from '../in-cluster-idp-seed.js'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import type { IKubectl } from '../kubectl.js'

class FakeKubectl implements IKubectl
{
    public Applied: string[] = []

    public async Apply(manifestJson: string): Promise<void>
    {
        this.Applied.push(manifestJson)
    }

    public async RolloutStatus(): Promise<void> { }
    public async SetImage(): Promise<void> { }
    public async Scale(): Promise<void> { }
    public async ScaleStatefulSet(): Promise<void> { }
    public async RolloutRestart(): Promise<void> { }
    public async Get(): Promise<string> { return '' }
    public async DeleteNamespace(): Promise<void> { }
}

type Secret = { apiVersion: string, kind: string, metadata: { name: string, namespace: string }, data: Record<string, string> }

describe('InClusterIdpSeedSource', () =>
{
    const Tenant = 't1'
    const Secrets = (manifest: string): Secret[] => JSON.parse(manifest).items as Secret[]

    it('HostOf is the internal host alone, or internal + idp-<tenant>.<baseDomain> with a baseDomain', () =>
    {
        const internal = new URL(K8sManifestBuilder.IdpBaseUrlOf(Tenant, 9443)).hostname
        assert.deepEqual(InClusterIdpSeedSource.HostOf(Tenant), [internal])
        assert.deepEqual(InClusterIdpSeedSource.HostOf(Tenant, 'd.localtest'), [internal, 'idp-t1.d.localtest'])
    })

    it('a seed built with a baseDomain mints a cert carrying both SANs; without one only the internal SAN', () =>
    {
        const sanOf = (source: InClusterIdpSeedSource): string =>
        {
            const crt = Secrets(source.SecretsManifestFor(Tenant)).find(s => s.metadata.name.endsWith('-tls'))!.data['server.crt']
            return new X509Certificate(Buffer.from(crt, 'base64')).subjectAltName ?? ''
        }
        const dual = sanOf(new InClusterIdpSeedSource(undefined, 'd.localtest'))
        assert.ok(dual.includes('DNS:idp-t1.d.localtest'))
        assert.ok(dual.includes(`DNS:${InClusterIdpSeedSource.HostOf(Tenant)[0]}`))
        assert.ok(!sanOf(new InClusterIdpSeedSource()).includes('d.localtest'))
    })

    it('renders Secret names that byte-match the refs RenderIdp mounts', async () =>
    {
        const source = new InClusterIdpSeedSource()
        const kubectl = new FakeKubectl()
        await new InClusterIdpDriver(kubectl, new K8sManifestBuilder(), source, 'hive-a', 'img').EnsureRunning({ tenantId: Tenant, displayName: 'T', takenPorts: [] })
        assert.equal(kubectl.Applied.length, 2)
        const seedNames = Secrets(kubectl.Applied[1]!).map(s => s.metadata.name)
        const mounted = (JSON.parse(kubectl.Applied[0]!).items as any[]).find(o => o.kind === 'Deployment').spec.template.spec.volumes
            .filter((v: any) => v.secret !== undefined).map((v: any) => v.secret.secretName)
        assert.deepEqual(seedNames.sort(), mounted.sort())
        const seed = source.SeedFor(Tenant)
        assert.deepEqual(mounted.sort(), [seed.adminTokenSecretName, seed.tlsSecretName].sort())
    })

    it('issues a server cert whose SAN equals the Service-DNS host IdpBaseUrlOf encodes', () =>
    {
        const source = new InClusterIdpSeedSource()
        const host = new URL(K8sManifestBuilder.IdpBaseUrlOf(Tenant, 9443)).hostname
        const tls = Secrets(source.SecretsManifestFor(Tenant)).find(s => s.metadata.name === source.SeedFor(Tenant).tlsSecretName)!
        const dir = mkdtempSync(join(tmpdir(), 'seed-test-'))
        try
        {
            const crt = join(dir, 'server.crt')
            writeFileSync(crt, Buffer.from(tls.data['server.crt']!, 'base64'))
            const text = execFileSync('openssl', ['x509', '-in', crt, '-noout', '-text']).toString()
            assert.ok(text.includes(`DNS:${host}`))
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('projects the TLS Secret with exactly server.crt/server.key/ca.crt and never the CA signing key', () =>
    {
        const source = new InClusterIdpSeedSource()
        const tls = Secrets(source.SecretsManifestFor(Tenant)).find(s => s.metadata.name === source.SeedFor(Tenant).tlsSecretName)!
        assert.deepEqual(Object.keys(tls.data).sort(), ['ca.crt', 'server.crt', 'server.key'])
        assert.equal(tls.data['ca.key'], undefined)
    })

    it('never leaks the TLS private key or admin token through toString / toJSON', () =>
    {
        const source = new InClusterIdpSeedSource()
        const secrets = source.SecretsFor(Tenant)
        const tls = Secrets(secrets.RenderManifest())[0]!
        const keyB64 = tls.data['server.key']!
        const keyPem = Buffer.from(keyB64, 'base64').toString()
        const token = source.SeedFor(Tenant).adminToken
        for (const target of [source, secrets])
        {
            for (const text of [String(target), `${target}`, JSON.stringify(target), JSON.stringify({ wrapped: target })])
            {
                assert.ok(!text.includes(token))
                assert.ok(!text.includes(keyB64))
                assert.ok(!text.includes(keyPem))
                assert.ok(!text.includes('PRIVATE KEY'))
            }
        }
    })

    it('renders v1 Secrets with base64 data in the IdP namespace', () =>
    {
        const source = new InClusterIdpSeedSource()
        const list = JSON.parse(source.SecretsManifestFor(Tenant))
        assert.equal(list.apiVersion, 'v1')
        assert.equal(list.kind, 'List')
        const items = list.items as Secret[]
        assert.equal(items.length, 2)
        for (const s of items)
        {
            assert.equal(s.apiVersion, 'v1')
            assert.equal(s.kind, 'Secret')
            assert.equal(s.metadata.namespace, K8sManifestBuilder.IdpNameOf(Tenant))
            for (const v of Object.values(s.data))
            {
                assert.equal(Buffer.from(v, 'base64').toString('base64'), v)
            }
        }
        const admin = items.find(s => s.metadata.name === source.SeedFor(Tenant).adminTokenSecretName)!
        assert.equal(Buffer.from(admin.data[source.SeedFor(Tenant).adminTokenRef]!, 'base64').toString(), source.SeedFor(Tenant).adminToken)
    })

    it('keeps the secret manifests out of the workload manifest and is stable per tenant', async () =>
    {
        const source = new InClusterIdpSeedSource()
        const kubectl = new FakeKubectl()
        await new InClusterIdpDriver(kubectl, new K8sManifestBuilder(), source, 'hive-a', 'img').EnsureRunning({ tenantId: Tenant, displayName: 'T', takenPorts: [] })
        assert.ok(!kubectl.Applied[0]!.includes(source.SeedFor(Tenant).adminToken))
        assert.ok(!kubectl.Applied[0]!.includes('"kind":"Secret"'))
        assert.equal(source.SeedFor(Tenant), source.SeedFor(Tenant))
    })
})
