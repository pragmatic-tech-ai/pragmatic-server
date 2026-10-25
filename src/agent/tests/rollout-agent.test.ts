import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RolloutAgent } from '../rollout-agent.js'
import type { IEnvironmentState, IRolloutAgentDeps, IRolloutTarget, ISnapshotEnvironment } from '../rollout-agent.js'

class FakeDeps
{
    public Target: IRolloutTarget | undefined = { version: '2', image: 'img:2' }
    public Envs: IEnvironmentState[] = []
    public ListCalls = 0
    public readonly Patches: string[][] = []
    public readonly Snapshots: ReadonlyArray<ISnapshotEnvironment>[] = []

    public Build(): IRolloutAgentDeps
    {
        return {
            fetchTarget: async () => this.Target,
            listEnvironments: async () =>
            {
                this.ListCalls++
                return this.Envs
            },
            patchImage: async (namespace: string, deployment: string, container: string, image: string) =>
            {
                this.Patches.push([namespace, deployment, container, image])
            },
            reportSnapshot: async (environments: ReadonlyArray<ISnapshotEnvironment>) =>
            {
                this.Snapshots.push(environments)
            },
        }
    }
}

test('Tick patches only off-target envs and reports one snapshot of all envs', async () =>
{
    const fake = new FakeDeps()
    fake.Envs = [
        { environmentName: 'dev', namespace: 'ns-dev', deployment: 'srv', container: 'app', runningImage: 'img:2', ready: true },
        { environmentName: 'prod', namespace: 'ns-prod', deployment: 'srv', container: 'app', runningImage: 'img:1', ready: false },
    ]
    await new RolloutAgent(fake.Build()).Tick()
    assert.deepEqual(fake.Patches, [['ns-prod', 'srv', 'app', 'img:2']])
    assert.equal(fake.Snapshots.length, 1)
    const snap = fake.Snapshots[0]
    assert.equal(snap.length, 2)
    assert.equal(snap[0].environmentName, 'dev')
    assert.equal(snap[0].ready, true)
    assert.equal(snap[0].runningImage, 'img:2')
    assert.equal(snap[1].environmentName, 'prod')
    assert.equal(snap[1].ready, false)
    assert.equal(snap[1].runningImage, 'img:1')
    assert.notEqual(snap[0].detail, snap[1].detail)
    assert.ok(snap[0].detail.length > 0)
})

test('Tick with an empty hive patches nothing and reports an empty snapshot', async () =>
{
    const fake = new FakeDeps()
    await new RolloutAgent(fake.Build()).Tick()
    assert.deepEqual(fake.Patches, [])
    assert.deepEqual(fake.Snapshots, [[]])
})

test('Tick with no target neither lists, patches nor reports', async () =>
{
    const fake = new FakeDeps()
    fake.Target = undefined
    await new RolloutAgent(fake.Build()).Tick()
    assert.equal(fake.ListCalls, 0)
    assert.deepEqual(fake.Patches, [])
    assert.deepEqual(fake.Snapshots, [])
})
