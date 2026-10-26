import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KubectlCli, KubectlError } from '../kubectl.js'
import type { IExecFile } from '../kubectl.js'

interface RunCall
{
    file: string
    args: readonly string[]
    stdin?: string
}

class FakeExecFile implements IExecFile
{
    public readonly Calls: RunCall[] = []
    public Stdout = ''
    public FailStderr: string | undefined

    public async Run(file: string, args: readonly string[], stdin?: string): Promise<{ stdout: string; stderr: string }>
    {
        this.Calls.push({ file, args, stdin })
        if (this.FailStderr !== undefined)
        {
            throw Object.assign(new Error('Command failed'), { stderr: this.FailStderr })
        }
        return { stdout: this.Stdout, stderr: '' }
    }
}

class KubectlFixture
{
    public static readonly Context = 'kind-hive'
    public static readonly PlantedToken = 'QWxhZGRpbjpvcGVuIHNlc2FtZTEyMzQ1Njc4OTBhYmNkZWY='

    public readonly Fake = new FakeExecFile()
    public readonly Cli = new KubectlCli(KubectlFixture.Context, this.Fake)

    public get Last(): RunCall
    {
        return this.Fake.Calls[this.Fake.Calls.length - 1]
    }
}

test('Apply runs kubectl apply -f - with manifest on stdin', async () =>
{
    const f = new KubectlFixture()
    await f.Cli.Apply('{"kind":"List"}')
    assert.equal(f.Last.file, 'kubectl')
    assert.ok(Array.isArray(f.Last.args))
    assert.deepEqual(f.Last.args, ['--context', 'kind-hive', 'apply', '-f', '-'])
    assert.equal(f.Last.stdin, '{"kind":"List"}')
})

test('RolloutStatus args', async () =>
{
    const f = new KubectlFixture()
    await f.Cli.RolloutStatus('ns1', 'web')
    assert.deepEqual(f.Last.args, ['--context', 'kind-hive', 'rollout', 'status', 'deployment/web', '-n', 'ns1'])
})

test('SetImage args', async () =>
{
    const f = new KubectlFixture()
    await f.Cli.SetImage('ns1', 'web', 'app', 'img:2')
    assert.deepEqual(f.Last.args, ['--context', 'kind-hive', 'set', 'image', 'deployment/web', 'app=img:2', '-n', 'ns1'])
})

test('Scale args', async () =>
{
    const f = new KubectlFixture()
    await f.Cli.Scale('ns', 'dep', 0)
    assert.deepEqual(f.Last.args, ['--context', 'kind-hive', 'scale', 'deployment/dep', '--replicas=0', '-n', 'ns'])
})

test('Get args and returns stdout', async () =>
{
    const f = new KubectlFixture()
    f.Fake.Stdout = '{"items":[]}'
    const out = await f.Cli.Get('ns1', 'pods')
    assert.equal(out, '{"items":[]}')
    assert.deepEqual(f.Last.args, ['--context', 'kind-hive', 'get', 'pods', '-n', 'ns1', '-o', 'json'])
})

test('DeleteNamespace args', async () =>
{
    const f = new KubectlFixture()
    await f.Cli.DeleteNamespace('ns1')
    assert.deepEqual(f.Last.args, ['--context', 'kind-hive', 'delete', 'namespace', 'ns1', '--ignore-not-found'])
})

test('failure throws KubectlError with secrets redacted from stderr', async () =>
{
    const f = new KubectlFixture()
    f.Fake.FailStderr = `error: bad auth token ${KubectlFixture.PlantedToken} and password=hunter2 here`
    await assert.rejects(() => f.Cli.Apply('{}'), (e: unknown) =>
    {
        assert.ok(e instanceof KubectlError)
        assert.ok(!e.message.includes(KubectlFixture.PlantedToken))
        assert.ok(!e.message.includes('hunter2'))
        assert.ok(e.message.includes('bad auth'))
        return true
    })
})
