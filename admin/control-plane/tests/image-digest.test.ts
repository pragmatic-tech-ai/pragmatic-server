import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DockerImageDigest } from '../image-digest.js'
import type { IExecFile } from '../kubectl.js'

class FakeExecFile implements IExecFile
{
    public calls: { file: string; args: readonly string[] }[] = []

    public constructor(private readonly stdout: string)
    {
    }

    public async Run(file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }>
    {
        this.calls.push({ file, args })
        return { stdout: this.stdout, stderr: '' }
    }
}

describe('DockerImageDigest', () =>
{
    it('inspects the image via an argument array and returns the trimmed id', async () =>
    {
        const exec = new FakeExecFile('sha256:abc123\n')
        const digest = await new DockerImageDigest(exec).Of('localhost:5000/pragmatic-server:dev')
        assert.equal(digest, 'sha256:abc123')
        assert.equal(exec.calls.length, 1)
        assert.equal(exec.calls[0].file, 'docker')
        assert.deepEqual(exec.calls[0].args, ['image', 'inspect', 'localhost:5000/pragmatic-server:dev', '--format', '{{.Id}}'])
    })
})
