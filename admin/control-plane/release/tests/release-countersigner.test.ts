import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { IImageSigner } from '../../image-signer.js'
import { PlatformReleaseCountersigner } from '../release-countersigner.js'

class RecordingSigner implements IImageSigner
{
    public readonly Calls: { imageRef: string; keyRef: string }[] = []

    public constructor(private readonly failOn?: string)
    {
    }

    public async Sign(imageRef: string, signingKeyRef: string): Promise<void>
    {
        this.Calls.push({ imageRef, keyRef: signingKeyRef })
        if (imageRef === this.failOn)
        {
            throw new SecretBearingError()
        }
    }
}

class SecretBearingError extends Error
{
    public static readonly Secret = 'ghp_never_logged'

    public constructor()
    {
        super('signing failed with ' + SecretBearingError.Secret)
        this.name = 'SecretBearingError'
    }
}

class Refs
{
    public static readonly KeyRef = 'platform-signing'
    public static readonly A = 'ghcr.io/pragmatic-tech-ai/a@sha256:' + 'a'.repeat(64)
    public static readonly B = 'ghcr.io/pragmatic-tech-ai/b@sha256:' + 'b'.repeat(64)
}

describe('PlatformReleaseCountersigner', () =>
{
    it('signs every image with the platform key ref', async () =>
    {
        const signer = new RecordingSigner()
        await new PlatformReleaseCountersigner(signer, Refs.KeyRef).Countersign([Refs.A, Refs.B])
        assert.deepEqual(signer.Calls, [{ imageRef: Refs.A, keyRef: Refs.KeyRef }, { imageRef: Refs.B, keyRef: Refs.KeyRef }])
    })

    it('logs a failed image by ref and error name, never throws, and still signs the rest', async t =>
    {
        const warn = t.mock.method(console, 'warn', () => undefined)
        const signer = new RecordingSigner(Refs.A)
        await new PlatformReleaseCountersigner(signer, Refs.KeyRef).Countersign([Refs.A, Refs.B])
        assert.equal(signer.Calls.length, 2)
        assert.equal(warn.mock.callCount(), 1)
        const line = String(warn.mock.calls[0].arguments[0])
        assert.ok(line.includes(Refs.A), line)
        assert.ok(line.includes('SecretBearingError'), line)
        assert.ok(!line.includes(SecretBearingError.Secret), line)
    })
})
