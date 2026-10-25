import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RolloutAgent } from '../rollout-agent.js'
import type { IEnvironmentState, IRolloutAgentDeps, IRolloutTarget, ISnapshotEnvironment } from '../rollout-agent.js'

const TargetImage = 'img:2'
const OldImage = 'img:1'
const TargetVersion = '2'
const Deployment = 'srv'
const Container = 'app'
const DevName = 'dev'
const DevNamespace = 'ns-dev'
const ProdName = 'prod'
const ProdNamespace = 'ns-prod'

class FakeDeps
{
    public Target: IRolloutTarget | undefined = { version: TargetVersion, image: TargetImage }
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
        { environmentName: DevName, namespace: DevNamespace, deployment: Deployment, container: Container, runningImage: TargetImage, ready: true },
        { environmentName: ProdName, namespace: ProdNamespace, deployment: Deployment, container: Container, runningImage: OldImage, ready: false },
    ]
    await new RolloutAgent(fake.Build()).Tick()
    assert.deepEqual(fake.Patches, [[ProdNamespace, Deployment, Container, TargetImage]])
    assert.equal(fake.Snapshots.length, 1)
    const snap = fake.Snapshots[0]
    assert.equal(snap.length, 2)
    assert.equal(snap[0].environmentName, DevName)
    assert.equal(snap[0].ready, true)
    assert.equal(snap[0].runningImage, TargetImage)
    assert.equal(snap[1].environmentName, ProdName)
    assert.equal(snap[1].ready, false)
    assert.equal(snap[1].runningImage, OldImage)
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

test('Tick patches an env with an undefined running image and still reports it', async () =>
{
    const fake = new FakeDeps()
    fake.Envs = [
        { environmentName: DevName, namespace: DevNamespace, deployment: Deployment, container: Container, runningImage: undefined, ready: false },
    ]
    await new RolloutAgent(fake.Build()).Tick()
    assert.deepEqual(fake.Patches, [[DevNamespace, Deployment, Container, TargetImage]])
    assert.equal(fake.Snapshots.length, 1)
    assert.equal(fake.Snapshots[0].length, 1)
    assert.equal(fake.Snapshots[0][0].environmentName, DevName)
    assert.equal(fake.Snapshots[0][0].runningImage, undefined)
})
