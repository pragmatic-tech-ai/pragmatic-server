import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RolloutAgent } from '../rollout-agent.js'

class FakeDeps
{
    public readonly Calls: string[] = []
    public Target: { version: string; image: string } | undefined = { version: '2', image: 'img:2' }
    public Running: string | undefined = 'img:1'
    public PatchError: Error | undefined

    public Build(): ConstructorParameters<typeof RolloutAgent>[0]
    {
        return {
            fetchTarget: async () =>
            {
                this.Calls.push('fetch')
                return this.Target
            },
            readRunningImage: async () =>
            {
                this.Calls.push('read')
                return this.Running
            },
            patchImage: async (image: string) =>
            {
                this.Calls.push('patch:' + image)
                if (this.PatchError !== undefined)
                {
                    throw this.PatchError
                }
            },
            report: async (image: string, ready: boolean) =>
            {
                this.Calls.push('report:' + image + ':' + ready)
            },
        }
    }
}

test('Tick patches then reports when target differs from running', async () =>
{
    const fake = new FakeDeps()
    await new RolloutAgent(fake.Build()).Tick()
    assert.deepEqual(fake.Calls, ['fetch', 'read', 'patch:img:2', 'report:img:2:true'])
})

test('Tick does not patch when already running the target, still reports', async () =>
{
    const fake = new FakeDeps()
    fake.Running = 'img:2'
    await new RolloutAgent(fake.Build()).Tick()
    assert.deepEqual(fake.Calls, ['fetch', 'read', 'report:img:2:true'])
})

test('Tick with no target neither patches nor reports', async () =>
{
    const fake = new FakeDeps()
    fake.Target = undefined
    await new RolloutAgent(fake.Build()).Tick()
    assert.deepEqual(fake.Calls, ['fetch'])
})

test('Tick rejects when patchImage rejects, without reporting', async () =>
{
    const fake = new FakeDeps()
    fake.PatchError = new Error('boom')
    await assert.rejects(new RolloutAgent(fake.Build()).Tick(), /boom/)
    assert.ok(!fake.Calls.some(c => c.startsWith('report')))
})
