import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KubectlCli, KubectlError, NodeExecFile } from '../kubectl.js'
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

test('RolloutRestart args', async () =>
{
    const f = new KubectlFixture()
    await f.Cli.RolloutRestart('ns', 'dep')
    assert.deepEqual(f.Last.args, ['--context', 'kind-hive', 'rollout', 'restart', 'deployment/dep', '-n', 'ns'])
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

class RedactionFixture
{
    public static readonly LongName = 'pragmatic-env-production-eastus-server-deployment-0'
    public static readonly LongPath = '/var/lib/kubelet/pods/0a1b2c3d-aaaa-bbbb-cccc-0123456789ab/volumes'

    public static async MessageFor(stderr: string): Promise<string>
    {
        const f = new KubectlFixture()
        f.Fake.FailStderr = stderr
        try
        {
            await f.Cli.Apply('{}')
        }
        catch (e)
        {
            return (e as Error).message
        }
        throw new Error('expected a KubectlError')
    }
}

test('redacts a short unlabelled bearer credential', async () =>
{
    const msg = await RedactionFixture.MessageFor('error: Authorization: Bearer abc123 rejected')
    assert.ok(!msg.includes('abc123'))
    assert.ok(msg.includes('rejected'))
})

test('redacts a JSON-quoted password', async () =>
{
    const msg = await RedactionFixture.MessageFor('body {"password":"x1y2","user":"bob"} refused')
    assert.ok(!msg.includes('x1y2'))
    assert.ok(msg.includes('refused'))
})

test('redacts a quoted secret value containing spaces', async () =>
{
    const msg = await RedactionFixture.MessageFor('failed password="correct horse battery" at apply')
    assert.ok(!msg.includes('horse'))
    assert.ok(!msg.includes('battery'))
    assert.ok(msg.includes('at apply'))
})

test('does not over-redact long resource names or paths', async () =>
{
    const msg = await RedactionFixture.MessageFor(`error: ${RedactionFixture.LongName} not found under ${RedactionFixture.LongPath}`)
    assert.ok(msg.includes(RedactionFixture.LongName))
    assert.ok(msg.includes(RedactionFixture.LongPath))
})

test('falls back to the error message when stderr is empty, still redacted', async () =>
{
    const f = new KubectlFixture()
    f.Fake.Run = async () => { throw new Error('spawn failed token=zzz999') }
    await assert.rejects(() => f.Cli.Apply('{}'), (e: unknown) =>
    {
        assert.ok(e instanceof KubectlError)
        assert.ok(e.message.includes('spawn failed'))
        assert.ok(!e.message.includes('zzz999'))
        return true
    })
})

test('NodeExecFile honours a custom timeout', async () =>
{
    const exec = new NodeExecFile(150)
    const started = Date.now()
    await assert.rejects(() => exec.Run(process.execPath, ['-e', 'setTimeout(() => {}, 10000)']))
    assert.ok(Date.now() - started < 5000)
})

test('ScaleStatefulSet args', async () =>
{
    const f = new KubectlFixture()
    await f.Cli.ScaleStatefulSet('ns', 'db', 1)
    assert.deepEqual(f.Last.args, ['--context', 'kind-hive', 'scale', 'statefulset/db', '--replicas=1', '-n', 'ns'])
})
