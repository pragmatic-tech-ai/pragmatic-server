import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KindCli, KindError } from '../kind.js'
import type { IExecFile } from '../kubectl.js'

class FakeExecFile implements IExecFile
{
    public LastFile = ''
    public LastArgs: readonly string[] = []
    public readonly Calls: { file: string; args: readonly string[] }[] = []
    public Stdout = ''
    public FailStderr: string | undefined
    public FailError: Error | undefined

    public async Run(file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }>
    {
        this.LastFile = file
        this.LastArgs = args
        this.Calls.push({ file, args })
        if (this.FailError !== undefined)
        {
            throw this.FailError
        }
        if (this.FailStderr !== undefined)
        {
            throw Object.assign(new Error('exit 1'), { stderr: this.FailStderr })
        }
        return { stdout: this.Stdout, stderr: '' }
    }
}

test('CreateCluster runs kind create cluster --name <n>', async () =>
{
    const fake = new FakeExecFile()
    await new KindCli(fake).CreateCluster('c1')
    assert.equal(fake.LastFile, 'kind')
    assert.deepEqual(fake.LastArgs, ['create', 'cluster', '--name', 'c1'])
})

test('CreateCluster with extraPortMappings passes --config', async () =>
{
    const fake = new FakeExecFile()
    await new KindCli(fake).CreateCluster('c1', { extraPortMappings: [443] })
    assert.deepEqual(fake.LastArgs.slice(0, 4), ['create', 'cluster', '--name', 'c1'])
    assert.equal(fake.LastArgs[4], '--config')
    assert.equal(fake.LastArgs.length, 6)
})

test('RenderConfig maps container port to host port', () =>
{
    const yaml = KindCli.RenderConfig({ extraPortMappings: [443, 80] })
    assert.match(yaml, /containerPort: 443\n\s+hostPort: 443/)
    assert.match(yaml, /containerPort: 80\n\s+hostPort: 80/)
})

test('CreateCluster with an empty config is the bare command', async () =>
{
    const fake = new FakeExecFile()
    await new KindCli(fake).CreateCluster('c1', { extraPortMappings: [] })
    assert.deepEqual(fake.LastArgs, ['create', 'cluster', '--name', 'c1'])
})

test('DeleteCluster runs kind delete cluster --name <n>', async () =>
{
    const fake = new FakeExecFile()
    await new KindCli(fake).DeleteCluster('c1')
    assert.deepEqual(fake.LastArgs, ['delete', 'cluster', '--name', 'c1'])
})

// `kind load docker-image` imports with --all-platforms, which fails ("content digest ... not found") when Docker's
// containerd image store holds only the host platform of a multi-platform image. So LoadImage saves the host platform
// alone to an archive and loads that.
test('LoadImage saves the host platform to an archive, then runs kind load image-archive <archive> --name <n>', async () =>
{
    const fake = new FakeExecFile()
    await new KindCli(fake).LoadImage('img:1', 'c1')
    assert.equal(fake.Calls.length, 2)
    const [save, load] = fake.Calls
    assert.equal(save.file, 'docker')
    assert.deepEqual(save.args.slice(0, 3), ['save', '--platform', KindCli.HostPlatform()])
    assert.equal(save.args[3], '-o')
    assert.equal(save.args[5], 'img:1')
    assert.equal(load.file, 'kind')
    assert.deepEqual(load.args, ['load', 'image-archive', save.args[4], '--name', 'c1'])
})

test('the host platform is linux on the host CPU', () =>
{
    assert.match(KindCli.HostPlatform(), /^linux\/(amd64|arm64)$/)
})

test('a failed image save surfaces as KindError and never runs kind load', async () =>
{
    const fake = new FakeExecFile()
    fake.FailStderr = 'No such image: img:1'
    await assert.rejects(new KindCli(fake).LoadImage('img:1', 'c1'), (e: unknown) => e instanceof KindError && /No such image/.test(e.message))
    assert.equal(fake.Calls.length, 1)
})

test('LoadImage runs on the image-load exec (its own, longer timeout); every other call on the main one', async () =>
{
    const main = new FakeExecFile()
    const images = new FakeExecFile()
    const cli = new KindCli(main, images)
    await cli.LoadImage('img:1', 'c1')
    await cli.DeleteCluster('c1')
    assert.deepEqual(images.Calls.map(c => c.file), ['docker', 'kind'])
    assert.deepEqual(main.LastArgs, ['delete', 'cluster', '--name', 'c1'])
})

test('the image-load timeout allows a multi-GB image (at least 20 minutes)', () =>
{
    assert.ok(KindCli.ImageLoadTimeoutMs >= 20 * 60 * 1000)
})

test('ListClusters parses newline-separated names', async () =>
{
    const fake = new FakeExecFile()
    fake.Stdout = 'a\nb\n'
    assert.deepEqual(await new KindCli(fake).ListClusters(), ['a', 'b'])
    assert.deepEqual(fake.LastArgs, ['get', 'clusters'])
})

test('ListClusters returns [] for empty output and for the no-clusters sentinel', async () =>
{
    const fake = new FakeExecFile()
    fake.Stdout = ''
    assert.deepEqual(await new KindCli(fake).ListClusters(), [])
    fake.Stdout = 'No kind clusters found.\n'
    assert.deepEqual(await new KindCli(fake).ListClusters(), [])
})

test('a failed kind call throws KindError with redacted stderr', async () =>
{
    const fake = new FakeExecFile()
    fake.FailStderr = 'token=abcdefghijklmnopqrstuvwxyz012345'
    await assert.rejects(new KindCli(fake).CreateCluster('c1'), (e: unknown) =>
    {
        assert.ok(e instanceof KindError)
        assert.ok(e.message.includes('[REDACTED]'))
        assert.ok(!e.message.includes('abcdefghijklmnopqrstuvwxyz012345'))
        return true
    })
})

test('a failed kind call with no stderr falls back to the error message, still redacted', async () =>
{
    const fake = new FakeExecFile()
    fake.FailError = new Error('boom token=abcdefghijklmnopqrstuvwxyz012345')
    await assert.rejects(new KindCli(fake).CreateCluster('c1'), (e: unknown) =>
    {
        assert.ok(e instanceof KindError)
        assert.ok(e.message.includes('boom'))
        assert.ok(e.message.includes('[REDACTED]'))
        assert.ok(!e.message.includes('abcdefghijklmnopqrstuvwxyz012345'))
        return true
    })
})
