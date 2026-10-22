import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { KubectlHiveOrchestrator } from '../kubectl-hive-orchestrator.js'
import { UnsupportedBackendError } from '../hive-orchestrator.js'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import type { IKubectl } from '../kubectl.js'
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
    public async Get(n: string, r: string)
    {
        await this.Record('Get', [n, r])
        return this.getResponses.length > 1 ? this.getResponses.shift()! : this.getResponses[0]
    }
    public DeleteNamespace(n: string) { return this.Record('DeleteNamespace', [n]) }
    public async Version() { return 'v' }
}

class Fixture
{
    public static readonly Ns = 'pragmatic-env-dev1'
    public static readonly Dep = 'pragmatic-env-dev1-server'

    public static Workload(withDb: boolean): EnvironmentWorkload
    {
        const w: EnvironmentWorkload = { environmentName: 'dev1', hiveId: 'h', image: 'srv:1', serverPort: 8080, env: {}, secretRefs: ['s'] }
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

    public static Make()
    {
        const k = new FakeKubectl()
        return { k, o: new KubectlHiveOrchestrator(k, new K8sManifestBuilder(), { attempts: 3, intervalMs: 1 }) }
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
