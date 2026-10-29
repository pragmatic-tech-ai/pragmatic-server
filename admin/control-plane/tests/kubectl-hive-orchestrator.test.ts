import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { KubectlHiveOrchestrator } from '../kubectl-hive-orchestrator.js'
import { UnsupportedBackendError } from '../hive-orchestrator.js'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import type { IKubectl } from '../kubectl.js'
import type { EffectiveRegistry } from '../effective-registry.js'
import type { IImageVerifier } from '../image-verifier.js'
import type { EnvironmentWorkload } from '../environment-workload.js'

class FakeKubectl implements IKubectl
{
    public calls: string[][] = []
    public rejectOn = new Set<string>()
    public getResponses: string[] = []

    private Record(method: string, args: string[]): Promise<void>
    {
        this.calls.push([method, ...args])
        return this.rejectOn.has(method) ? Promise.reject(new Error('boom ' + method)) : Promise.resolve()
    }

    public Apply(m: string) { return this.Record('Apply', [m]) }
    public RolloutStatus(n: string, d: string) { return this.Record('RolloutStatus', [n, d]) }
    public SetImage(n: string, d: string, c: string, i: string) { return this.Record('SetImage', [n, d, c, i]) }
    public Scale(n: string, d: string, r: number) { return this.Record('Scale', [n, d, String(r)]) }
    public ScaleStatefulSet(n: string, d: string, r: number) { return this.Record('ScaleStatefulSet', [n, d, String(r)]) }
    public RolloutRestart(n: string, d: string) { return this.Record('RolloutRestart', [n, d]) }
    public async Get(n: string, r: string)
    {
        await this.Record('Get', [n, r])
        return this.getResponses.length > 1 ? this.getResponses.shift()! : this.getResponses[0]
    }
    public DeleteNamespace(n: string) { return this.Record('DeleteNamespace', [n]) }
}

class FakeRegistry
{
    public constructor(private readonly prefix: string = '')
    {
    }

    public ImageRef(baseImage: string): string
    {
        return this.prefix + baseImage
    }
}

class FakeVerifier implements IImageVerifier
{
    public verified: Array<[string, string | undefined]> = []
    public reject = false

    public Verify(imageRef: string, trustRootRef?: string): Promise<void>
    {
        this.verified.push([imageRef, trustRootRef])
        return this.reject ? Promise.reject(new Error('unverified ' + imageRef)) : Promise.resolve()
    }
}

class Fixture
{
    public static readonly Trust = 'root-1'

    public static readonly Ns = 'pragmatic-env-dev1'
    public static readonly Dep = 'pragmatic-env-dev1-server'

    public static Workload(withDb: boolean): EnvironmentWorkload
    {
        const w: EnvironmentWorkload = { environmentName: 'dev1', environmentId: 'dev1-id', hiveId: 'h', image: 'srv:1', serverPort: 8080, env: {}, secretRefs: ['s'] }
        if (withDb)
        {
            w.database = { image: 'postgres:16', user: 'u', database: 'd', passwordRef: 'p' }
        }
        return w
    }

    public static Deployment(ready: number, image: string): string
    {
        return JSON.stringify({
            spec: { template: { spec: { containers: [{ name: 'sidecar', image: 'x:1' }, { name: 'server', image }] } } },
            status: { readyReplicas: ready },
        })
    }

    public static Make(prefix: string = '')
    {
        const k = new FakeKubectl()
        const v = new FakeVerifier()
        const registry = new FakeRegistry(prefix) as unknown as EffectiveRegistry
        return { k, v, o: new KubectlHiveOrchestrator(k, new K8sManifestBuilder(), registry, v, Fixture.Trust, { attempts: 3, intervalMs: 1 }) }
    }
}

describe('KubectlHiveOrchestrator', () =>
{
    it('Apply sends exactly the rendered manifest', async () =>
    {
        const { k, o } = Fixture.Make()
        await o.Apply(Fixture.Workload(true))
        assert.deepEqual(k.calls, [['Apply', new K8sManifestBuilder().Render(Fixture.Workload(true))]])
    })

    it('Apply verifies the effective image and the manifest carries it', async () =>
    {
        const { k, v, o } = Fixture.Make('localhost:5000/')
        await o.Apply(Fixture.Workload(true))
        assert.deepEqual(v.verified, [['localhost:5000/srv:1', Fixture.Trust]])
        assert.deepEqual(k.calls, [['Apply', new K8sManifestBuilder().Render({ ...Fixture.Workload(true), image: 'localhost:5000/srv:1' })]])
    })

    it('Apply never reaches kubectl when verification rejects', async () =>
    {
        const { k, v, o } = Fixture.Make('localhost:5000/')
        v.reject = true
        await assert.rejects(o.Apply(Fixture.Workload(true)), /unverified localhost:5000\/srv:1/)
        assert.deepEqual(k.calls, [])
    })

    it('Scale calls kubectl.Scale with the derived namespace and deployment', async () =>
    {
        const { o, k } = Fixture.Make()
        await o.Scale(Fixture.Workload(false), 0)
        assert.deepEqual(k.calls, [['Scale', Fixture.Ns, Fixture.Dep, '0']])
    })

    it('ScaleDatabase to 0 scales the StatefulSet and does not wait', async () =>
    {
        const { o, k } = Fixture.Make()
        await o.ScaleDatabase(Fixture.Workload(true), 0)
        assert.deepEqual(k.calls, [['ScaleStatefulSet', Fixture.Ns, K8sManifestBuilder.DatabaseOf('dev1'), '0']])
    })

    it('ScaleDatabase to 1 scales the StatefulSet then waits until a replica is ready', async () =>
    {
        const { o, k } = Fixture.Make()
        k.getResponses = [JSON.stringify({ status: { readyReplicas: 0 } }), JSON.stringify({ status: { readyReplicas: 1 } })]
        await o.ScaleDatabase(Fixture.Workload(true), 1)
        assert.deepEqual(k.calls.map(c => c[0]), ['ScaleStatefulSet', 'Get', 'Get'])
    })

    it('Roll verifies the effective image before SetImage', async () =>
    {
        const { k, v, o } = Fixture.Make('localhost:5000/')
        await o.Roll(Fixture.Workload(false), 'srv:2')
        assert.deepEqual(v.verified, [['localhost:5000/srv:2', Fixture.Trust]])
        assert.deepEqual(k.calls[0], ['SetImage', Fixture.Ns, Fixture.Dep, 'server', 'localhost:5000/srv:2'])
    })

    it('Roll never reaches SetImage when verification rejects', async () =>
    {
        const { k, v, o } = Fixture.Make('localhost:5000/')
        v.reject = true
        await assert.rejects(o.Roll(Fixture.Workload(false), 'srv:2'), /unverified/)
        assert.deepEqual(k.calls, [])
    })

    it('WaitHealthy waits for the server rollout only when no database', async () =>
    {
        const { k, o } = Fixture.Make()
        await o.WaitHealthy(Fixture.Workload(false))
        assert.deepEqual(k.calls, [['RolloutStatus', Fixture.Ns, Fixture.Dep]])
    })

    it('WaitHealthy also waits for the postgres statefulset, polling until ready', async () =>
    {
        const { k, o } = Fixture.Make()
        k.getResponses = [JSON.stringify({ status: {} }), JSON.stringify({ status: { readyReplicas: 1 } })]
        await o.WaitHealthy(Fixture.Workload(true))
        const db = ['Get', Fixture.Ns, 'statefulset/pragmatic-env-dev1-postgres']
        assert.deepEqual(k.calls, [['RolloutStatus', Fixture.Ns, Fixture.Dep], db, db])
    })

    it('WaitHealthy rejects when the database never becomes ready', async () =>
    {
        const { k, o } = Fixture.Make()
        k.getResponses = [JSON.stringify({ status: {} })]
        await assert.rejects(o.WaitHealthy(Fixture.Workload(true)), /database not ready/)
    })

    it('WaitHealthy propagates RolloutStatus rejection', async () =>
    {
        const { k, o } = Fixture.Make()
        k.rejectOn.add('RolloutStatus')
        await assert.rejects(o.WaitHealthy(Fixture.Workload(true)), /boom RolloutStatus/)
        assert.equal(k.calls.length, 1)
    })

    it('Roll sets the image then waits for rollout, in order', async () =>
    {
        const { k, o } = Fixture.Make()
        await o.Roll(Fixture.Workload(false), 'srv:2')
        assert.deepEqual(k.calls, [['SetImage', Fixture.Ns, Fixture.Dep, 'server', 'srv:2'], ['RolloutStatus', Fixture.Ns, Fixture.Dep]])
    })

    it('Roll rejects if SetImage rejects, without waiting', async () =>
    {
        const { k, o } = Fixture.Make()
        k.rejectOn.add('SetImage')
        await assert.rejects(o.Roll(Fixture.Workload(false), 'srv:2'), /boom SetImage/)
        assert.deepEqual(k.calls.map(c => c[0]), ['SetImage'])
    })

    it('Roll rejects if RolloutStatus rejects', async () =>
    {
        const { k, o } = Fixture.Make()
        k.rejectOn.add('RolloutStatus')
        await assert.rejects(o.Roll(Fixture.Workload(false), 'srv:2'), /boom RolloutStatus/)
    })

    it('Health parses ready replicas and the server container image', async () =>
    {
        const { k, o } = Fixture.Make()
        k.getResponses = [Fixture.Deployment(1, 'srv:2')]
        const h = await o.Health(Fixture.Workload(false))
        assert.deepEqual(k.calls, [['Get', Fixture.Ns, 'deployment/' + Fixture.Dep]])
        assert.equal(h.ready, true)
        assert.equal(h.runningImage, 'srv:2')
        assert.match(h.detail, /1/)
        assert.match(h.detail, /srv:2/)
    })

    it('Health reports not ready with no readyReplicas and tolerates a missing image', async () =>
    {
        const { k, o } = Fixture.Make()
        k.getResponses = [JSON.stringify({ status: {} })]
        const h = await o.Health(Fixture.Workload(false))
        assert.equal(h.ready, false)
        assert.equal(h.runningImage, undefined)
    })

    it('Teardown deletes only the environment namespace', async () =>
    {
        const { k, o } = Fixture.Make()
        await o.Teardown(Fixture.Workload(true))
        assert.deepEqual(k.calls, [['DeleteNamespace', Fixture.Ns]])
    })

    it('UnsupportedBackendError names backend and mode', () =>
    {
        const e = new UnsupportedBackendError(HiveBackend.Aks, InfraMode.Provision)
        assert.match(e.message, /aks/)
        assert.match(e.message, /provision/)
    })
})
