import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PinnedImageVerifier } from '../pinned-image-verifier.js'
import { ImageVerificationError } from '../image-verifier.js'

class PinnedFixture
{
    public static IsNotVerified(ref: string): (e: unknown) => boolean
    {
        return (e: unknown) => e instanceof ImageVerificationError
            && e.Reason === PinnedImageVerifier.NotVerifiedReason
            && e.ImageRef === ref
    }

    public static WithDir(body: (dir: string) => void): void
    {
        const dir = mkdtempSync(join(tmpdir(), 'pinned-'))
        try
        {
            body(dir)
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    }
}

test('accepts only listed refs', async () =>
{
    const verifier = new PinnedImageVerifier([{ imageRef: 'localhost:5000/srv:1' }])
    await verifier.Verify('localhost:5000/srv:1', undefined)
    await verifier.Verify('localhost:5000/srv:1', 'root-1')
    await assert.rejects(verifier.Verify('localhost:5000/srv:2', 'root-1'), PinnedFixture.IsNotVerified('localhost:5000/srv:2'))
    await assert.rejects(verifier.Verify('srv:1', 'root-1'), PinnedFixture.IsNotVerified('srv:1'))
})

test('Load of a missing file refuses everything', async () =>
{
    let verifier: PinnedImageVerifier | undefined
    PinnedFixture.WithDir(dir =>
    {
        verifier = PinnedImageVerifier.Load(join(dir, 'verified-images.json'))
    })
    await assert.rejects(verifier!.Verify('srv:1', 'root-1'), PinnedFixture.IsNotVerified('srv:1'))
})

test('Load reads a JSON array of verified images', async () =>
{
    let verifier: PinnedImageVerifier | undefined
    PinnedFixture.WithDir(dir =>
    {
        const path = join(dir, 'verified-images.json')
        writeFileSync(path, JSON.stringify([{ imageRef: 'reg/srv:1' }, { imageRef: 'reg/srv:2' }]))
        verifier = PinnedImageVerifier.Load(path)
    })
    await verifier!.Verify('reg/srv:2', undefined)
    await assert.rejects(verifier!.Verify('reg/srv:3', undefined), PinnedFixture.IsNotVerified('reg/srv:3'))
})

test('Load of a malformed file fails with a sentence naming the file', () =>
{
    PinnedFixture.WithDir(dir =>
    {
        const path = join(dir, 'verified-images.json')
        writeFileSync(path, JSON.stringify({ imageRef: 'not-an-array' }))
        assert.throws(() => PinnedImageVerifier.Load(path), (e: unknown) => e instanceof Error && e.message.includes(path))
        writeFileSync(path, '[{"imageRef": 5}]')
        assert.throws(() => PinnedImageVerifier.Load(path), (e: unknown) => e instanceof Error && e.message.includes(path))
        writeFileSync(path, '[{')
        assert.throws(() => PinnedImageVerifier.Load(path), (e: unknown) => e instanceof Error && e.message.includes(path))
    })
})
