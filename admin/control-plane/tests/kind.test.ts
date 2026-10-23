import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KindCli, KindError } from '../kind.js'
import type { IExecFile } from '../kubectl.js'

class FakeExecFile implements IExecFile
{
    public LastFile = ''
    public LastArgs: readonly string[] = []
    public Stdout = ''
    public FailStderr: string | undefined
    public FailError: Error | undefined

    public async Run(file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }>
    {
        this.LastFile = file
        this.LastArgs = args
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

test('DeleteCluster runs kind delete cluster --name <n>', async () =>
{
    const fake = new FakeExecFile()
    await new KindCli(fake).DeleteCluster('c1')
    assert.deepEqual(fake.LastArgs, ['delete', 'cluster', '--name', 'c1'])
})

test('LoadImage runs kind load docker-image <image> --name <n>', async () =>
{
    const fake = new FakeExecFile()
    await new KindCli(fake).LoadImage('img:1', 'c1')
    assert.deepEqual(fake.LastArgs, ['load', 'docker-image', 'img:1', '--name', 'c1'])
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
