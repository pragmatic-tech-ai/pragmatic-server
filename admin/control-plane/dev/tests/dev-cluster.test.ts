import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { IKind, KindClusterConfig } from '../../kind.js'
import type { IExecFile } from '../../kubectl.js'
import { DevCluster } from '../dev-cluster.js'

class FakeKind implements IKind
{
    public readonly Calls: string[] = []

    public constructor(private readonly clusters: string[] = [])
    {
    }

    public async CreateCluster(name: string, config?: KindClusterConfig): Promise<void>
    {
        this.Calls.push('create ' + name + (config === undefined ? '' : ' ports ' + config.extraPortMappings.join(',')))
        this.clusters.push(name)
    }

    public async DeleteCluster(name: string): Promise<void>
    {
        this.Calls.push('delete ' + name)
    }

    public async ListClusters(): Promise<readonly string[]>
    {
        return [...this.clusters]
    }

    public async LoadImage(image: string, clusterName: string): Promise<void>
    {
        this.Calls.push('load ' + image + ' ' + clusterName)
    }
}

/** A docker whose local store holds `present`; inspect of anything else fails, pull always succeeds. */
class FakeDocker implements IExecFile
{
    public readonly Calls: string[] = []

    public constructor(private readonly present: readonly string[])
    {
    }

    public async Run(file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }>
    {
        this.Calls.push([file, ...args].join(' '))
        if (args[1] === 'inspect' && !this.present.includes(args[2]!))
        {
            throw new Error('No such image')
        }
        return { stdout: '', stderr: '' }
    }
}

class DevClusterFx
{
    public static readonly AllImages = ['pragmatic-server:dev', 'registry:2', 'postgres:16']
    public static readonly Loads = DevClusterFx.AllImages.map(i => 'load ' + i + ' pragmatic-dev')

    public static Silent(kind: IKind, docker: IExecFile): DevCluster
    {
        return new DevCluster(kind, docker, () => undefined)
    }
}

describe('DevCluster.Up', () =>
{
    it('creates the missing cluster with no host port mappings, then loads every image onto it', async () =>
    {
        const kind = new FakeKind()
        await DevClusterFx.Silent(kind, new FakeDocker(DevClusterFx.AllImages)).Up()
        assert.deepEqual(kind.Calls, ['create pragmatic-dev', ...DevClusterFx.Loads])
    })

    it('reuses an existing cluster and still re-loads the images (a rebuilt server image reaches the node)', async () =>
    {
        const kind = new FakeKind(['pragmatic-dev', 'pragmatic-e2e'])
        await DevClusterFx.Silent(kind, new FakeDocker(DevClusterFx.AllImages)).Up()
        assert.deepEqual(kind.Calls, DevClusterFx.Loads)
    })

    it('pulls a missing public image before loading it', async () =>
    {
        const docker = new FakeDocker(['pragmatic-server:dev', 'registry:2'])
        await DevClusterFx.Silent(new FakeKind(), docker).Up()
        assert.ok(docker.Calls.includes('docker pull postgres:16'))
        assert.ok(!docker.Calls.includes('docker pull registry:2'))
    })

    it('refuses when the server image was never built, and never tries to pull it', async () =>
    {
        const kind = new FakeKind()
        const docker = new FakeDocker(['registry:2', 'postgres:16'])
        await assert.rejects(DevClusterFx.Silent(kind, docker).Up(), /pragmatic-server:dev is not in the local docker store; build it first/)
        assert.ok(!docker.Calls.includes('docker pull pragmatic-server:dev'))
        assert.ok(!kind.Calls.some(c => c.startsWith('load ')))
    })
})

describe('DevCluster.Down', () =>
{
    it('deletes the cluster when it exists', async () =>
    {
        const kind = new FakeKind(['pragmatic-dev'])
        await DevClusterFx.Silent(kind, new FakeDocker([])).Down()
        assert.deepEqual(kind.Calls, ['delete pragmatic-dev'])
    })

    it('does nothing when it does not exist', async () =>
    {
        const kind = new FakeKind(['pragmatic-e2e'])
        await DevClusterFx.Silent(kind, new FakeDocker([])).Down()
        assert.deepEqual(kind.Calls, [])
    })
})
