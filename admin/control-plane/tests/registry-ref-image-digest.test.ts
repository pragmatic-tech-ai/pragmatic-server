import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RegistryRefImageDigest, TagReferenceError } from '../image-digest.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CryptoImageVerifier, ImageVerificationError, FileKeyStore } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { FileSignatureStore } from '../signature-store.js'

class Refs
{
    public static readonly Digest = 'sha256:' + 'a'.repeat(64)
    public static readonly ByDigest = 'ghcr.io/pragmatic-tech-ai/pragmatic-hive-agent@' + Refs.Digest
    public static readonly LocalTag = 'pragmatic-server:dev'
    public static readonly RegistryTag = 'ghcr.io/x/y:1.0'
    public static readonly ShortDigest = 'ghcr.io/x/y@sha256:abc'
    public static readonly TempPrefix = 'registry-ref-digest-'
    public static readonly SignaturesFile = 'signatures.json'
    public static readonly KeyRef = 'platform-signing'
}

describe('RegistryRefImageDigest', () =>
{
    it('a tag reference reaching verification is an ImageVerificationError naming the image, with no docker call', async () =>
    {
        const keysDir = mkdtempSync(join(tmpdir(), Refs.TempPrefix))
        try
        {
            const verifier = new CryptoImageVerifier(new RegistryRefImageDigest(), new FileSignatureStore(join(keysDir, Refs.SignaturesFile)), new FileKeyStore(keysDir))
            await assert.rejects(verifier.Verify(Refs.RegistryTag, Refs.KeyRef), (err: unknown) =>
                err instanceof ImageVerificationError && err instanceof TagReferenceError && err.ImageRef === Refs.RegistryTag
                && err.message === 'Image ' + Refs.RegistryTag + ' is not pinned by digest')
        }
        finally
        {
            rmSync(keysDir, { recursive: true, force: true })
        }
    })

    it('returns the digest of a by-digest reference', async () =>
    {
        assert.equal(await new RegistryRefImageDigest().Of(Refs.ByDigest), Refs.Digest)
    })

    it('refuses a tag reference without calling docker', async () =>
    {
        const digests = new RegistryRefImageDigest()
        for (const ref of [Refs.LocalTag, Refs.RegistryTag, Refs.ShortDigest])
        {
            await assert.rejects(digests.Of(ref), (err: unknown) =>
                err instanceof TagReferenceError && err.message === 'Image ' + ref + ' is not pinned by digest')
        }
    })
})
