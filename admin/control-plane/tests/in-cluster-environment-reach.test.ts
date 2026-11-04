import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { EnvironmentUnreachableError } from '../environment-endpoints.js'
import type { EnvironmentRecord } from '../environment-record.js'
import { InClusterEnvironmentReach } from '../in-cluster-environment-reach.js'
import type { IKubectl } from '../kubectl.js'

class Names
{
    public static readonly EnvName = 'a'
    public static readonly EnvironmentId = 'e1'
    public static readonly Namespace = 'pragmatic-env-a'
    public static readonly SecretRef = 'secret/a-env-secrets'
    public static readonly Password = 'p-w-1'
    public static readonly Http = 'http://s.ns.svc.cluster.local:8080'
    public static readonly Ws = 'ws://s.ns.svc.cluster.local:8080/?environment=e1'
}

class FakeKubectl
{
    public readonly Reads: string[] = []

    public async Get(namespace: string, resource: string): Promise<string>
    {
        this.Reads.push(namespace + '/' + resource)
        const secrets = JSON.stringify({ [Names.EnvironmentId + '-admin-pw']: Names.Password })
        return JSON.stringify({ data: { 'provisioned-secrets.json': Buffer.from(secrets).toString('base64') } })
    }
}

class RecordKit
{
    public static Make(extra: Partial<EnvironmentRecord>): EnvironmentRecord
    {
        return { name: Names.EnvName, environmentId: Names.EnvironmentId, ...extra } as EnvironmentRecord
    }
}

describe('InClusterEnvironmentReach', () =>
{
    it('UrlsFor returns origin-only endpoint URLs', async () =>
    {
        const reach = new InClusterEnvironmentReach(new FakeKubectl() as unknown as IKubectl)
        const lease = await reach.UrlsFor(RecordKit.Make({ endpoint: { httpUrl: Names.Http + '/x?y=1', wsUrl: Names.Ws } }))
        assert.equal(lease.httpUrl, Names.Http)
        assert.equal(lease.wsUrl, 'ws://s.ns.svc.cluster.local:8080')
        lease.Release()
        lease.Fail()
    })

    it('UrlsFor without an endpoint is unreachable', async () =>
    {
        const reach = new InClusterEnvironmentReach(new FakeKubectl() as unknown as IKubectl)
        await assert.rejects(() => reach.UrlsFor(RecordKit.Make({})), EnvironmentUnreachableError)
    })

    it('AdminPasswordFor reads the env Secret through the kubectl', async () =>
    {
        const kubectl = new FakeKubectl()
        const reach = new InClusterEnvironmentReach(kubectl as unknown as IKubectl)
        assert.equal(await reach.AdminPasswordFor(RecordKit.Make({}), 'unused'), Names.Password)
        assert.deepEqual(kubectl.Reads, [Names.Namespace + '/' + Names.SecretRef])
    })

    it('a Docker record keeps its local URLs', async () =>
    {
        const reach = new InClusterEnvironmentReach(new FakeKubectl() as unknown as IKubectl)
        const lease = await reach.UrlsFor(RecordKit.Make({ hostPort: 7777 }))
        assert.equal(lease.httpUrl, 'http://localhost:7777')
        assert.equal(lease.wsUrl, 'ws://localhost:7777')
    })

    it('a Docker record reads its password from the local bundle, not the cluster', async () =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'reach-'))
        try
        {
            mkdirSync(join(dir, Names.EnvName))
            writeFileSync(join(dir, Names.EnvName, 'provisioned-secrets.json'), JSON.stringify({ [Names.EnvironmentId + '-admin-pw']: Names.Password }))
            const kubectl = new FakeKubectl()
            const reach = new InClusterEnvironmentReach(kubectl as unknown as IKubectl)
            assert.equal(await reach.AdminPasswordFor(RecordKit.Make({ hostPort: 7777 }), dir), Names.Password)
            assert.deepEqual(kubectl.Reads, [])
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
